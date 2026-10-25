"""OSM extract -> compact directed road graph (roads.json) for the in-process car simulation."""
import json
import re
import shutil
import urllib.request
from collections import Counter
from pathlib import Path

import osmium

ROOT = Path(__file__).resolve().parent.parent
CONFIG = json.loads((ROOT / 'sim' / 'config.json').read_text())
MPH = 0.44704
# Parking aisles and drive-throughs are not through roads; emergency access forbids private cars.
EXCLUDED_SERVICE = {'parking_aisle', 'drive-through', 'emergency_access'}
FORBIDDING = {'no', 'private', 'agricultural', 'forestry', 'delivery', 'customers', 'destination_only_permit'}
ONEWAY_CLASSES = {'motorway', 'motorway_link'}


def download(url, target):
    """Downloads once to a cache path; a partial file never masquerades as complete."""
    target = Path(target)
    if target.exists():
        return target
    target.parent.mkdir(parents=True, exist_ok=True)
    part = target.with_suffix(target.suffix + '.part')
    print(f'Downloading {url}', flush=True)
    with urllib.request.urlopen(url, timeout=60) as response, open(part, 'wb') as out:
        shutil.copyfileobj(response, out, 1 << 20)
    part.replace(target)
    return target


def exclusion(tags, classes):
    """None for roads cars may use in this build, else the reason it is left out."""
    highway = tags.get('highway')
    if highway not in classes:
        return f'class {highway} not included'
    if tags.get('area') == 'yes':
        return 'area'
    if highway == 'service' and tags.get('service') in EXCLUDED_SERVICE:
        return f"service={tags.get('service')}"
    for key in ('motorcar', 'motor_vehicle', 'vehicle', 'access'):  # most specific first
        if key in tags:
            if tags[key] in FORBIDDING:
                return f'{key}={tags[key]}'
            if tags[key] in ('yes', 'designated', 'permissive'):
                break
    return None


def speed_limit(tags, defaults):
    """(m/s, inferred?) from maxspeed, else the configured class default."""
    match = re.match(r'\s*(\d+(?:\.\d+)?)\s*(mph|km/h|kmh)?', tags.get('maxspeed', ''))
    if match:
        value = float(match.group(1))
        return round(value * (MPH if match.group(2) == 'mph' else 1 / 3.6), 2), False
    return round(defaults[tags['highway']] * MPH, 2), True


def lanes_per_direction(tags, oneway):
    def number(key):
        match = re.match(r'\s*(\d+)', tags.get(key, ''))
        return int(match.group(1)) if match else None
    total = number('lanes')
    if oneway:
        forward = total or 1
        return min(4, forward), 0
    forward, backward = number('lanes:forward'), number('lanes:backward')
    half = max(1, (total or 2) // 2)
    return min(4, forward or half), min(4, backward or half)


def strongly_connected(successors):
    """Iterative Tarjan over the edge graph; returns the largest component."""
    index, low, on_stack, stack, best = {}, {}, set(), [], set()
    counter = 0
    for root in successors:
        if root in index:
            continue
        work = [(root, iter(successors[root]))]
        index[root] = low[root] = counter; counter += 1
        stack.append(root); on_stack.add(root)
        while work:
            node, children = work[-1]
            advanced = False
            for child in children:
                if child not in index:
                    index[child] = low[child] = counter; counter += 1
                    stack.append(child); on_stack.add(child)
                    work.append((child, iter(successors.get(child, ()))))
                    advanced = True
                    break
                if child in on_stack:
                    low[node] = min(low[node], index[child])
            if advanced:
                continue
            work.pop()
            if work:
                low[work[-1][0]] = min(low[work[-1][0]], low[node])
            if low[node] == index[node]:
                component = set()
                while True:
                    member = stack.pop(); on_stack.discard(member); component.add(member)
                    if member == node:
                        break
                if len(component) > len(best):
                    best = component
    return best


def build(source, out, bbox, classes):
    west, south, east, north = bbox
    defaults = CONFIG['network']['speedDefaultsMph']
    excluded, ways, signal_points = Counter(), [], []
    inside = lambda node: west <= node.lon <= east and south <= node.lat <= north
    processor = osmium.FileProcessor(str(source), osmium.osm.NODE | osmium.osm.WAY).with_locations()  # filters run after locations
    for way in processor.with_filter(osmium.filter.KeyFilter('highway')):
        if way.is_node():
            if way.tags.get('highway') == 'traffic_signals' and inside(way.location):
                signal_points.append((way.location.lon, way.location.lat))
            continue
        tags = {tag.k: tag.v for tag in way.tags}
        reason = exclusion(tags, classes)
        if reason:
            excluded[reason] += 1
            continue
        nodes = [(node.ref, round(node.lon, 6), round(node.lat, 6)) for node in way.nodes if node.location.valid()]
        if len(nodes) < 2 or not any(inside(node.location) for node in way.nodes if node.location.valid()):
            continue
        ways.append((way.id, tags, nodes))
    # Split ways into edges at junctions: nodes shared by several ways, or way ends.
    uses = Counter(ref for _, _, nodes in ways for ref, *_ in nodes)
    edges = []  # [from_node, to_node, class, lanes, speed, inferred, two_way, coords, way_id, name]
    for way_id, tags, nodes in ways:
        name = tags.get('name') or tags.get('ref') or ''
        oneway = tags.get('oneway') in ('yes', 'true', '1', '-1') or tags.get('junction') in ('roundabout', 'circular') or tags['highway'] in ONEWAY_CLASSES
        if tags.get('oneway') == '-1':
            nodes = nodes[::-1]
        forward, backward = lanes_per_direction(tags, oneway)
        speed, inferred = speed_limit(tags, defaults)
        piece = [nodes[0]]
        for node in nodes[1:]:
            piece.append(node)
            if uses[node[0]] > 1 or node is nodes[-1]:
                coords = [value for _, lon, lat in piece for value in (lon, lat)]
                edges.append([piece[0][0], piece[-1][0], tags['highway'], forward, speed, inferred, not oneway, coords, way_id, name])
                if not oneway:
                    back = [value for _, lon, lat in piece[::-1] for value in (lon, lat)]
                    edges.append([piece[-1][0], piece[0][0], tags['highway'], backward, speed, inferred, True, back, way_id, name])
                piece = [node]
    # Keep only the largest strongly connected part so no car can reach a dead end.
    leaving = {}
    for i, edge in enumerate(edges):
        leaving.setdefault(edge[0], []).append(i)
    keep = strongly_connected({i: leaving.get(edge[1], []) for i, edge in enumerate(edges)})
    kept = [edge for i, edge in enumerate(edges) if i in keep]
    node_ids = {ref: n for n, ref in enumerate(sorted({ref for edge in kept for ref in edge[:2]}))}
    class_names = sorted({edge[2] for edge in kept})
    names = sorted({edge[9] for edge in kept})
    name_index = {name: k for k, name in enumerate(names)}
    lengths = [sum(haversine(*edge[7][k:k + 4]) for k in range(0, len(edge[7]) - 2, 2)) for edge in kept]
    signals = snap_signals(signal_points, kept, node_ids)
    roads = {
        'bbox': bbox, 'classes': class_names, 'nodes': len(node_ids), 'names': names,
        # Signalised junction node indices (OpenStreetMap highway=traffic_signals snapped to junctions).
        'signals': signals,
        # Each edge: [from, to, class index, lanes, speed m/s, speed inferred 0/1, two-way 0/1, length m, [lon, lat, ...],
        #             OSM way id, name index]. The two directions of a two-way road share the way id.
        'edges': [[node_ids[e[0]], node_ids[e[1]], class_names.index(e[2]), e[3], e[4], int(e[5]), int(e[6]), round(length, 1), e[7], e[8], name_index[e[9]]]
                  for e, length in zip(kept, lengths)],
    }
    Path(out).parent.mkdir(parents=True, exist_ok=True)
    Path(out).write_text(json.dumps(roads, separators=(',', ':')))
    by_class = Counter(class_names[e[2]] for e in roads['edges'])
    return {
        'edges': len(kept), 'droppedDisconnected': len(edges) - len(kept), 'nodes': len(node_ids),
        'laneKm': round(sum(e[3] * e[7] for e in roads['edges']) / 1000, 1), 'roadKm': round(sum(lengths) / 1000, 1),
        'inferredSpeedShare': round(sum(e[5] for e in roads['edges']) / max(1, len(kept)), 3),
        'signals': {'osmNodes': len(signal_points), 'junctions': len(signals)},
        'byClass': dict(by_class.most_common()), 'excludedWays': dict(excluded.most_common(12)),
        'megabytes': round(Path(out).stat().st_size / 2 ** 20, 2),
    }


def snap_signals(points, edges, node_ids, metres=25):
    """Junction node indices with a signal within `metres`. Junctions join 3+ other nodes, so a lone
    pedestrian signal on a plain stretch of road matches nothing and is dropped."""
    neighbours, position = {}, {}
    for e in edges:
        neighbours.setdefault(e[0], set()).add(e[1]); neighbours.setdefault(e[1], set()).add(e[0])
        position[e[0]] = e[7][:2]; position[e[1]] = e[7][-2:]
    cell = 0.0005  # ~35 m in latitude, ~55 m in longitude: a 3x3 search covers 25 m
    grid = {}
    for ref, others in neighbours.items():
        if len(others) >= 3:
            lon, lat = position[ref]
            grid.setdefault((int(lon // cell), int(lat // cell)), []).append(ref)
    snapped = set()
    for lon, lat in points:
        best, best_distance = None, metres
        for dx in (-1, 0, 1):
            for dy in (-1, 0, 1):
                for ref in grid.get((int(lon // cell) + dx, int(lat // cell) + dy), ()):
                    distance = haversine(lon, lat, *position[ref])
                    if distance <= best_distance:
                        best, best_distance = ref, distance
        if best is not None:
            snapped.add(node_ids[best])
    return sorted(snapped)


def haversine(lon1, lat1, lon2, lat2):
    from math import asin, cos, radians, sin, sqrt
    a = sin(radians(lat2 - lat1) / 2) ** 2 + cos(radians(lat1)) * cos(radians(lat2)) * sin(radians(lon2 - lon1) / 2) ** 2
    return 2 * 6_371_000 * asin(sqrt(a))
