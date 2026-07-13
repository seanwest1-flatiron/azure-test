// Public SPA configuration. Never put a client secret or access token here.
(() => {
  const productionRedirectUri = "https://seanwest1-flatiron.github.io/azure-test/";
  const localRedirectUri = "http://localhost:4173/";

  window.AFTER_PARTY_CONFIG = Object.freeze({
    clientId: "f1d183a6-1a01-4daf-b5ca-70f44427de17",
    authority: "https://login.microsoftonline.com/organizations",
    redirectUri: window.location.origin === "http://localhost:4173" ? localRedirectUri : productionRedirectUri,
    repositoryRawBase: "https://raw.githubusercontent.com/seanwest1-flatiron/azure-test/main",
    runbookName: "AfterPartyBootstrap"
  });
})();
