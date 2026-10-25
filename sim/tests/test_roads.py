import json
import tempfile
import unittest
from pathlib import Path

from sim.roads import MPH, build

FIXTURE = Path(__file__).resolve().parent.parent / 'fixtures' / 'mini.osm'
CLASSES = {'trunk', 'primary', 'secondary', 'tertiary', 'unclassified', 'residential', 'service'}


class RoadBuildTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        with tempfile.TemporaryDirectory() as out:
            cls.stats = build(FIXTURE, Path(out) / 'roads.json', [-0.14, 51.5, -0.12, 51.52], CLASSES)
            cls.roads = json.loads((Path(out) / 'roads.json').read_text())

    def edges(self, cls):
        return [e for e in self.roads['edges'] if self.roads['classes'][e[2]] == cls]

    def test_excludes_non_car_and_forbidden_roads(self):
        self.assertEqual(self.stats['excludedWays'], {'class footway not included': 1, 'access=private': 1, 'motor_vehicle=no': 1})

    def test_one_way_roads_have_one_direction_and_two_way_roads_both(self):
        self.assertEqual(len(self.edges('secondary')), 1)
        self.assertTrue(all(e[6] == 0 for e in self.edges('secondary')))
        self.assertEqual(len(self.edges('primary')) % 2, 0)

    def test_speeds_convert_mph_and_mark_class_defaults(self):
        primary = self.edges('primary')[0]
        self.assertAlmostEqual(primary[4], 30 * MPH, places=2)
        self.assertEqual(primary[5], 0)
        residential = self.edges('residential')[0]
        self.assertAlmostEqual(residential[4], 20 * MPH, places=2)
        self.assertEqual(residential[5], 1)

    def test_bridge_crossing_is_not_a_junction(self):
        flyover_nodes = {n for e in self.edges('trunk') for n in e[:2]}
        primary_nodes = {n for e in self.edges('primary') for n in e[:2]}
        # The flyover only meets the network at its own ends, never where it crosses the high street.
        self.assertTrue(flyover_nodes)
        self.assertFalse(flyover_nodes & primary_nodes)

    def test_signal_is_snapped_to_its_junction(self):
        self.assertEqual(self.stats['signals'], {'osmNodes': 1, 'junctions': 1})
        junction = self.roads['signals'][0]
        # The high-street junction: the signal node joins 4 roads.
        self.assertEqual(len({e[0] for e in self.roads['edges'] if e[1] == junction}), 4)


if __name__ == '__main__':
    unittest.main()
