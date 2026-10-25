// Use the real onboarding and tab buttons; do not unhide controls behind the UI.
export async function enterMap(page) {
  await page.locator('#intro-skip').click();
  await page.locator('#loading-screen').waitFor({ state: 'hidden' });
}
export async function selectTab(page, name) {
  const id = name === 'performance' ? 'tab-btn-performance' : `tab-${name}`;
  await page.locator(`#${id}`).click();
}
export async function fixtureOptionalFeeds(context) {
  const empty = { type: 'FeatureCollection', features: [] };
  await context.route('**/api/trains/lines', route => route.fulfill({ json: empty }));
  await context.route('**/api/trains', route => route.fulfill({ json: { status: 'live', trains: [], notice: 'Fixture' } }));
  await context.route('**/api/trains/busyness', route => route.fulfill({ json: empty }));
  await context.route('**/api/stops', route => route.fulfill({ json: { items: [], people: 0, extraCars: 0, extraCarsTarget: 0, stoppedLines: [], economics: { active: false }, historyCount: 0 } }));
}
