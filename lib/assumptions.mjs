// Estimated, assumption-based: how many people a stopped train or bus displaces, and how many of them
// switch to driving. Change the numbers here; everything else reads them.
export const ASSUMPTIONS = {
  // Passengers on board = assumed capacity x average load.
  passengersPerVehicle: {
    tube: 800 * .35,
    'elizabeth-line': 1500 * .35,
    overground: 700 * .3,
    dlr: 280 * .35,
    bus: 85 * .4,
  },
  carShare: .10, // share of displaced people who switch to a car
  peoplePerCar: 1.3,
};

export const carsFor = people => Math.round(people * ASSUMPTIONS.carShare / ASSUMPTIONS.peoplePerCar);
