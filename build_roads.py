"""Builds data/network/roads.json, the road graph the car simulation runs on.

    .venv/bin/python build_roads.py                                   # configured area (sim/config.json)
    .venv/bin/python build_roads.py --bbox=-0.15,51.49,-0.10,51.52    # a small test area
    .venv/bin/python build_roads.py --classes +residential            # add a road class
    .venv/bin/python build_roads.py --input other.osm.pbf             # any local extract
"""
import argparse
import json
import time
from pathlib import Path

from sim.roads import CONFIG, ROOT, build, download

network = CONFIG['network']
parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
parser.add_argument('--input', help='local OSM extract; default: cached Geofabrik Greater London download')
parser.add_argument('--bbox', default=','.join(map(str, network['bbox'])), help='west,south,east,north')
parser.add_argument('--classes', default='', help='comma list replacing the configured classes, or +a,+b to add')
parser.add_argument('--out', default=str(ROOT / 'data' / 'network' / 'roads.json'))
args = parser.parse_args()

classes = set(network['classes'])
if args.classes:
    extra = [c for c in args.classes.split(',') if c]
    classes = classes | {c[1:] for c in extra} if all(c.startswith('+') for c in extra) else set(extra)
unknown = classes - set(network['speedDefaultsMph'])
if unknown:
    parser.error(f'no speed default for {sorted(unknown)}; add it to sim/config.json')
source = Path(args.input) if args.input else download(network['source'], ROOT / 'data' / 'osm' / 'greater-london-latest.osm.pbf')
started = time.time()
stats = build(source, args.out, [float(v) for v in args.bbox.split(',')], classes)
print(json.dumps({**stats, 'seconds': round(time.time() - started, 1), 'out': args.out}, indent=2))
