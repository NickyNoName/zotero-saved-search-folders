/* global Services, Zotero, SavedSearchFolders */
var SavedSearchFolders;

function install() {}

async function startup({ id, version, rootURI }) {
	Services.scriptloader.loadSubScript(rootURI + 'searchFolders.js');
	SavedSearchFolders.init({ id, version, rootURI });
	// Exposed for debugging from Tools → Developer → Run JavaScript
	Zotero.SavedSearchFolders = SavedSearchFolders;
	await Zotero.uiReadyPromise;
	SavedSearchFolders.addToAllWindows();
}

function onMainWindowLoad({ window }) {
	SavedSearchFolders?.addToWindow(window);
}

function onMainWindowUnload({ window }) {
	SavedSearchFolders?.removeFromWindow(window, true);
}

function shutdown() {
	SavedSearchFolders?.removeFromAllWindows();
	delete Zotero.SavedSearchFolders;
	SavedSearchFolders = undefined;
}

function uninstall() {}
