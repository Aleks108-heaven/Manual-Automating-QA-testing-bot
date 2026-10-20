// The fixture site's FAKE credentials. They protect nothing and exist so that tests and the CLI can
// exercise the secret-handling code. Real credentials never go in this repository (CLAUDE.md).
// Names follow the manual's reference form: "secret:<name>" in a case, "<name>" here.
export const FIXTURE_SECRETS: Readonly<Record<string, string>> = {
  "fixture_member.username": "fixture_member",
  "fixture_member.password": "Member#Pass-2026",
  "lock_test_01.username": "lock_test_01",
  "lock_test_01.password": "Correct#Pass1",
  "fixture_apikey.value": "fx-api-key-9f3a7c1d",
};
