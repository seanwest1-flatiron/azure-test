import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

const source = await readFile(new URL("../config.js", import.meta.url), "utf8");
const productionRedirectUri = "https://seanwest1-flatiron.github.io/azure-test/";

function configurationFor(origin) {
  const window = { location: { origin } };
  vm.runInNewContext(source, { window });
  return window.AFTER_PARTY_CONFIG;
}

test("uses the local redirect only for the fixed local development origin", () => {
  const config = configurationFor("http://localhost:4173");
  assert.equal(config.redirectUri, "http://localhost:4173/");
  assert.equal(config.clientId, "f1d183a6-1a01-4daf-b5ca-70f44427de17");
  assert.equal(Object.isFrozen(config), true);
});

test("keeps the production redirect for every other origin", () => {
  for (const origin of [
    "https://seanwest1-flatiron.github.io",
    "http://localhost:4174",
    "http://127.0.0.1:4173",
    "https://example.test"
  ]) {
    assert.equal(configurationFor(origin).redirectUri, productionRedirectUri, origin);
  }
});
