/* global Zotero, Services */
/*
 * Saved Search Folders for Zotero 10
 *
 * Everything is stored in the saved search name, so it syncs and degrades gracefully:
 *
 *   "People/Students/Marie Curie"  -> folder People > Students, search "Marie Curie"
 *   "2_People/1_Marie Curie"       -> same, with a manual order; the "N_" prefix is not shown
 *
 * Implementation: the main window's CollectionTree instance is patched so that, after Zotero has
 * added the saved-search rows under a library, those rows are regrouped under folder rows. Folder
 * rows are 'header'-type rows (not selectable, like "Group Libraries") with their own open state.
 *
 * Saved searches can also be combined on the fly (Ctrl/Cmd+click = AND, Shift+click = OR). The
 * combined result is shown by temporarily swapping the first search's row for a "combo" row whose
 * search object is built from the intersection/union of the individual results.
 */

SavedSearchFolders = {
	PREF_SEPARATOR: 'extensions.savedsearchfolders.separator',
	PREF_ORDER_SEPARATOR: 'extensions.savedsearchfolders.orderSeparator',
	PREF_OPEN: 'extensions.savedsearchfolders.openFolders',
	PREF_ROOT: 'extensions.savedsearchfolders.rootFolder',
	ROOT_LABEL: 'Saved Searches',
	ROW_PREFIX: 'HSF',
	// Search-level options that are stored as conditions
	FLAG_CONDITIONS: ['resultLevel', 'noChildren', 'includeParentsAndChildren', 'includeParents',
		'includeChildren', 'includeDeleted', 'recursive'],
	// What Zotero's own advanced search starts from
	BLANK_CONDITIONS: [
		{ condition: 'resultLevel', operator: 'item', value: '' },
		{ condition: 'title', operator: 'contains', value: '' }
	],
	STYLE: `
		/* Folder icon: Zotero's collection glyph in the saved-search cyan */
		#collection-tree .row.ssf-folder .icon-css.icon-collection {
			background: #59ADC4 !important;
			mask: url("chrome://zotero/skin/collection-tree/16/light/collection.svg") center / contain no-repeat;
		}
		@media (prefers-color-scheme: dark) {
			#collection-tree .row.ssf-folder .icon-css.icon-collection {
				background: #59ADC4E5 !important;
			}
		}
		#collection-tree .row.ssf-combo-member:not(.selected) {
			background-color: color-mix(in srgb, var(--accent-blue) 22%, transparent);
		}
		#collection-tree .ssf-combo-badge {
			margin-inline-start: 6px;
			padding: 0 6px;
			border-radius: 8px;
			font-size: 0.8em;
			line-height: 1.6;
			background: var(--accent-blue);
			color: #fff;
			flex-shrink: 0;
			white-space: nowrap;
		}
		#collection-tree .row.selected .ssf-combo-badge {
			background: rgba(255, 255, 255, 0.28);
		}
		/* Drag-and-drop position indicator */
		#collection-tree .row.ssf-drop-before::before,
		#collection-tree .row.ssf-drop-after::after {
			content: "";
			position: absolute;
			inset-inline: 4px;
			height: 2px;
			border-radius: 1px;
			background: var(--color-accent);
			pointer-events: none;
			z-index: 1;
		}
		#collection-tree .row.ssf-drop-before::before {
			top: -1px;
		}
		#collection-tree .row.ssf-drop-after::after {
			bottom: -1px;
		}
	`,

	id: null,
	version: null,
	rootURI: null,
	_windows: new Map(),
	_openState: null,
	_drag: null,
	_comboCounter: 0,

	init({ id, version, rootURI }) {
		this.id = id;
		this.version = version;
		this.rootURI = rootURI;
		this._loadOpenState();
	},

	log(msg) {
		Zotero.debug('Saved Search Folders: ' + msg);
	},

	// ---------------------------------------------------------------------------------------
	// Name <-> path helpers
	//
	// "Raw" segments are what is stored in the name (may carry an "N_" order prefix);
	// display names/paths have the prefix stripped and are used for folder identity.
	// ---------------------------------------------------------------------------------------

	getSeparator() {
		let sep = Zotero.Prefs.get(this.PREF_SEPARATOR, true);
		return (typeof sep == 'string' && sep.trim()) ? sep.trim() : '/';
	},

	getOrderSeparator() {
		let sep = Zotero.Prefs.get(this.PREF_ORDER_SEPARATOR, true);
		sep = typeof sep == 'string' ? sep.trim() : '';
		// Names are split on the folder separator first, so the two can't overlap
		let folderSep = this.getSeparator();
		return sep && !sep.includes(folderSep) && !folderSep.includes(sep) ? sep : '_';
	},

	orderRegExp() {
		let sep = this.getOrderSeparator().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
		return new RegExp(`^(\\d+)${sep}\\s*`);
	},

	splitPath(text) {
		return String(text || '').split(this.getSeparator()).map(s => s.trim()).filter(Boolean);
	},

	segmentName(raw) {
		return String(raw).replace(this.orderRegExp(), '') || String(raw);
	},

	segmentOrder(raw) {
		let re = this.orderRegExp();
		let m = String(raw).match(re);
		return m && String(raw).replace(re, '') ? parseInt(m[1]) : null;
	},

	withOrder(name, order, width = 1) {
		return order == null ? name : String(order).padStart(width, '0') + this.getOrderSeparator() + name;
	},

	/**
	 * @return {{ folderRaw: string[], folder: string[], leafRaw: string, leaf: string, order: ?number }}
	 */
	parse(name) {
		let parts = this.splitPath(name);
		if (parts.length < 2) {
			let raw = String(name || '');
			return {
				folderRaw: [],
				folder: [],
				leafRaw: raw,
				leaf: this.segmentName(raw.trim()),
				order: this.segmentOrder(raw.trim())
			};
		}
		let folderRaw = parts.slice(0, -1);
		let leafRaw = parts[parts.length - 1];
		return {
			folderRaw,
			folder: folderRaw.map(s => this.segmentName(s)),
			leafRaw,
			leaf: this.segmentName(leafRaw),
			order: this.segmentOrder(leafRaw)
		};
	},

	makeName(folderRaw, leafRaw) {
		return folderRaw.length ? [...folderRaw, leafRaw].join(this.getSeparator()) : leafRaw;
	},

	pathKey(path) {
		return JSON.stringify(path);
	},

	pathStartsWith(path, prefix) {
		return prefix.length <= path.length && prefix.every((p, i) => p === path[i]);
	},

	pathEquals(a, b) {
		return a.length == b.length && this.pathStartsWith(a, b);
	},

	rowID(libraryID, path) {
		return `${this.ROW_PREFIX}${libraryID}:${this.pathKey(path)}`;
	},

	isFolderRow(row) {
		return !!(row && row.ref && row.ref.ssfFolder);
	},

	// ---------------------------------------------------------------------------------------
	// Open/closed state of folders (local pref, like Zotero's own sourceList.persist)
	// ---------------------------------------------------------------------------------------

	_loadOpenState() {
		try {
			this._openState = JSON.parse(Zotero.Prefs.get(this.PREF_OPEN, true) || '{}') || {};
		}
		catch (e) {
			this._openState = {};
		}
	},

	_saveOpenState() {
		Zotero.Prefs.set(this.PREF_OPEN, JSON.stringify(this._openState), true);
	},

	isFolderOpen(libraryID, path) {
		// The "Saved Searches" root folder (empty path) is open unless closed explicitly
		if (!path.length) {
			return !this._openState[libraryID + ':rootClosed'];
		}
		return !!this._openState[libraryID + ':' + this.pathKey(path)];
	},

	setFolderOpen(libraryID, path, open) {
		if (!path.length) {
			if (open) {
				delete this._openState[libraryID + ':rootClosed'];
			}
			else {
				this._openState[libraryID + ':rootClosed'] = true;
			}
			this._saveOpenState();
			return;
		}
		let key = libraryID + ':' + this.pathKey(path);
		if (open) {
			this._openState[key] = true;
		}
		else {
			delete this._openState[key];
		}
		this._saveOpenState();
	},

	/** Mark a folder and all its ancestors (including the root folder) as open */
	openFolderPath(libraryID, path) {
		delete this._openState[libraryID + ':rootClosed'];
		for (let i = 1; i <= path.length; i++) {
			this._openState[libraryID + ':' + this.pathKey(path.slice(0, i))] = true;
		}
		this._saveOpenState();
	},

	/** Re-key open states when a folder is moved/renamed */
	moveOpenStates(libraryID, oldPath, newPath) {
		let prefix = libraryID + ':';
		for (let key of Object.keys(this._openState)) {
			if (!key.startsWith(prefix)) continue;
			let path;
			try {
				path = JSON.parse(key.substr(prefix.length));
			}
			catch (e) {
				continue;
			}
			if (Array.isArray(path) && this.pathStartsWith(path, oldPath)) {
				delete this._openState[key];
				this._openState[prefix + this.pathKey(newPath.concat(path.slice(oldPath.length)))] = true;
			}
		}
		this._saveOpenState();
	},

	// ---------------------------------------------------------------------------------------
	// Folder structure
	// ---------------------------------------------------------------------------------------

	newNode(name, path) {
		return { name, path, raw: null, order: null, folders: new Map(), searches: [] };
	},

	buildTree(searches) {
		let root = this.newNode('', []);
		for (let search of searches) {
			let { folderRaw } = this.parse(search.name);
			let node = root;
			for (let raw of folderRaw) {
				let name = this.segmentName(raw);
				if (!node.folders.has(name)) {
					node.folders.set(name, this.newNode(name, [...node.path, name]));
				}
				node = node.folders.get(name);
				// Folder order = lowest "N_" prefix used for it; raw = the spelling with that prefix
				let order = this.segmentOrder(raw);
				if (node.raw === null || (order !== null && (node.order === null || order < node.order))) {
					node.raw = raw;
					node.order = order;
				}
			}
			node.searches.push(search);
		}
		return root;
	},

	nodeAt(tree, path) {
		let node = tree;
		for (let name of path) {
			node = node.folders.get(name);
			if (!node) return null;
		}
		return node;
	},

	/** Raw segments for a display path; segments that don't exist yet use `hints` or the name */
	rawPathFor(tree, path, hints = []) {
		let raw = [];
		let node = tree;
		for (let i = 0; i < path.length; i++) {
			node = node && node.folders.get(path[i]);
			raw.push(node ? node.raw : (hints[i] || path[i]));
		}
		return raw;
	},

	/** Children of a node in display order: numbered entries first, then folders, then searches */
	children(node) {
		let entries = [...node.folders.values()].map(f => ({
			kind: 'folder', node: f, name: f.name, order: f.order
		}));
		for (let search of node.searches) {
			if (search.deleted) continue;
			let p = this.parse(search.name);
			entries.push({ kind: 'search', search, name: p.leaf, order: p.order });
		}
		entries.sort((a, b) => {
			let ao = a.order !== null;
			let bo = b.order !== null;
			if (ao != bo) return ao ? -1 : 1;
			if (ao && a.order != b.order) return a.order - b.order;
			if (a.kind != b.kind) return a.kind == 'folder' ? -1 : 1;
			return Zotero.localeCompare(a.name, b.name);
		});
		return entries;
	},

	allSearchesIn(node) {
		let result = [...node.searches];
		for (let child of node.folders.values()) {
			result.push(...this.allSearchesIn(child));
		}
		return result;
	},

	getSearches(libraryID, includeDeleted) {
		return Zotero.Searches.getByLibrary(libraryID).filter(s => includeDeleted || !s.deleted);
	},

	/** All folder paths in a library, in display order (for the "Move to folder" menu) */
	getFolderPaths(libraryID) {
		let paths = [];
		let walk = (node) => {
			for (let entry of this.children(node)) {
				if (entry.kind != 'folder') continue;
				paths.push(entry.node.path);
				walk(entry.node);
			}
		};
		walk(this.buildTree(this.getSearches(libraryID)));
		return paths;
	},

	/**
	 * Create tree rows for the children of a folder node
	 */
	makeRows(cv, node, libraryID, level) {
		let filtering = !cv._isFilterEmpty();
		let rows = [];
		for (let entry of this.children(node)) {
			if (entry.kind == 'folder') {
				let folder = entry.node;
				let ref = {
					ssfFolder: true,
					libraryID,
					path: folder.path,
					name: folder.name,
					label: folder.name,
					node: folder
				};
				if (filtering && !cv._includedInTree(ref)) {
					continue;
				}
				let row = new Zotero.CollectionTreeRow(cv, 'header', ref, level);
				Object.defineProperty(row, 'id', {
					value: this.rowID(libraryID, folder.path),
					configurable: true
				});
				// While the collection filter is active, show everything that matches
				row.isOpen = filtering || this.isFolderOpen(libraryID, folder.path);
				rows.push(row);
				if (row.isOpen) {
					rows.push(...this.makeRows(cv, folder, libraryID, level + 1));
				}
			}
			else {
				let search = entry.search;
				if (filtering && !cv._includedInTree(search)) {
					continue;
				}
				rows.push(this.makeSearchRow(cv, search, level));
			}
		}
		return rows;
	},

	useRoot() {
		return Zotero.Prefs.get(this.PREF_ROOT, true) !== false;
	},

	/**
	 * Rows for all saved searches of a library: by default one "Saved Searches" folder (a virtual
	 * folder that doesn't change any names) with the folder tree inside it
	 */
	makeLibraryRows(cv, tree, libraryID, level) {
		if (!this.useRoot()) {
			return this.makeRows(cv, tree, libraryID, level);
		}
		let filtering = !cv._isFilterEmpty();
		let ref = {
			ssfFolder: true,
			ssfRoot: true,
			libraryID,
			path: [],
			name: this.ROOT_LABEL,
			label: this.ROOT_LABEL,
			node: tree
		};
		if (filtering && !cv._includedInTree(ref)) {
			return [];
		}
		let row = new Zotero.CollectionTreeRow(cv, 'header', ref, level);
		Object.defineProperty(row, 'id', { value: this.rowID(libraryID, []), configurable: true });
		row.isOpen = filtering || this.isFolderOpen(libraryID, []);
		return row.isOpen ? [row, ...this.makeRows(cv, tree, libraryID, level + 1)] : [row];
	},

	isRootRow(row) {
		return !!(row && row.ref && row.ref.ssfRoot);
	},

	makeSearchRow(cv, search, level) {
		let row = new Zotero.CollectionTreeRow(cv, 'search', search, level);
		// Used for the label, the tab title and type-to-find
		row.getName = () => this.parse(search.name).leaf;
		return row;
	},

	// ---------------------------------------------------------------------------------------
	// Tree operations
	// ---------------------------------------------------------------------------------------

	/** Select a row and always fire the selection handlers (so the items list reloads) */
	selectRowIndex(cv, index) {
		let selection = cv.selection;
		selection.selectEventsSuppressed = true;
		selection.select(index);
		selection.selectEventsSuppressed = false;
	},

	async toggleFolder(cv, index, open) {
		let row = cv.getRow(index);
		if (!this.isFolderRow(row)) return;
		if (open === undefined) {
			open = !row.isOpen;
		}
		if (open == !!row.isOpen) return;

		let selection = cv.selection;
		let focusedID = cv.getRow(selection.focused)?.id;
		let selectedIDs = [...selection.selected].map(i => cv.getRow(i)?.id).filter(Boolean);
		let wasSuppressed = selection.selectEventsSuppressed;
		selection.selectEventsSuppressed = true;
		cv._lastToggleOpenStateIndex = index;

		if (row.isOpen) {
			let end = index + 1;
			while (end < cv._rows.length && cv._rows[end].level > row.level) {
				end++;
			}
			cv._rows.splice(index + 1, end - index - 1);
			row.isOpen = false;
		}
		else {
			let children = this.makeRows(cv, row.ref.node, row.ref.libraryID, row.level + 1);
			cv._rows.splice(index + 1, 0, ...children);
			row.isOpen = true;
		}
		if (cv._isFilterEmpty()) {
			this.setFolderOpen(row.ref.libraryID, row.ref.path, row.isOpen);
		}
		cv._refreshRowMap();

		// Keep the same rows selected; if they were all hidden inside the folder, select the library
		let selected = selectedIDs.map(id => cv._rowMap[id]).filter(i => i !== undefined);
		if (!selected.length) {
			selected = [cv._rowMap['L' + row.ref.libraryID] ?? 0];
		}
		let focused = focusedID !== undefined ? cv._rowMap[focusedID] : undefined;
		if (focused === undefined) {
			focused = selected[selected.length - 1];
		}
		selection.selected = new Set(selected);
		selection.focused = focused;
		selection.pivot = focused;
		selection.selectEventsSuppressed = wasSuppressed;
		cv.tree.invalidate();
		cv._lastToggleOpenStateIndex = null;
	},

	async expandToSearch(cv, search) {
		let { folder } = this.parse(search.name);
		for (let i = this.useRoot() ? 0 : 1; i <= folder.length; i++) {
			let index = cv._rowMap[this.rowID(search.libraryID, folder.slice(0, i))];
			if (index === undefined) return;
			if (!cv.getRow(index).isOpen) {
				await this.toggleFolder(cv, index, true);
			}
		}
	},

	/**
	 * Rebuild the whole tree and restore (or set) the selection
	 */
	async rebuild(cv, targetID, fallbackLibraryID) {
		await cv.refresh(); // Leaves select events suppressed
		// The rows were rebuilt, so the selected indices now point at different rows
		cv.selection.clearSelection();
		cv.tree.invalidate();
		let selected = false;
		if (targetID) {
			try {
				selected = await cv.selectByID(targetID);
			}
			catch (e) {
				selected = false;
			}
		}
		if (!selected) {
			await cv.selectByID('L' + (fallbackLibraryID || Zotero.Libraries.userLibraryID));
		}
		let promise = cv.waitForSelect();
		cv.selection.selectEventsSuppressed = false;
		return promise;
	},

	/**
	 * Re-render the React component so VirtualizedTable picks up the (un)patched renderItem/
	 * isContainerEmpty/toggleOpenState props, then redraw all rows with them
	 */
	updateProps(cv) {
		return new Promise((resolve) => {
			cv.forceUpdate(() => {
				cv.tree?.invalidate();
				resolve();
			});
		});
	},

	// ---------------------------------------------------------------------------------------
	// Window setup/teardown
	// ---------------------------------------------------------------------------------------

	async addToAllWindows() {
		for (let win of Zotero.getMainWindows()) {
			if (win.ZoteroPane) {
				await this.addToWindow(win);
			}
		}
	},

	removeFromAllWindows() {
		for (let win of [...this._windows.keys()]) {
			this.removeFromWindow(win);
		}
	},

	async waitForCollectionTree(win) {
		for (let i = 0; i < 600; i++) {
			if (win.closed) return null;
			let cv = win.ZoteroPane?.collectionsView;
			if (cv && cv.tree && cv._rowMap) {
				return cv;
			}
			await Zotero.Promise.delay(100);
		}
		return null;
	},

	async addToWindow(win) {
		if (this._windows.has(win)) return;
		let state = {
			cv: null,
			originals: {},
			listeners: [],
			elements: [],
			cleanups: [],
			combo: null,
			comboRow: null,
			comboPlainRow: null,
			contextSearch: null
		};
		this._windows.set(win, state);

		let cv = await this.waitForCollectionTree(win);
		if (!cv || this._windows.get(win) !== state) {
			this.log('collection tree not found');
			return;
		}
		// Let Zotero finish its initial load before rebuilding
		try {
			await Promise.race([cv.waitForLoad(), Zotero.Promise.delay(10000)]);
		}
		catch (e) {}
		if (this._windows.get(win) !== state) return;

		state.cv = cv;
		this.addStyle(win, state);
		this.patchSearchEditor(win, cv, state);
		this.patchSearchConditions(win, state);
		this.patchTree(cv, state);
		this.addListeners(win, cv, state);
		this.addMenus(win, cv, state);
		await this.updateProps(cv);

		let current = cv.getRow(cv.selection.focused);
		await this.rebuild(cv, current?.id, current?.ref?.libraryID);
		this.log('added to window');
	},

	removeFromWindow(win, windowClosing) {
		let state = this._windows.get(win);
		if (!state) return;
		this._windows.delete(win);

		let cv = state.cv;
		let current = cv?.getRow(cv.selection.focused);
		let id = this.isFolderRow(current) ? null : current?.id;
		if (current?.ssfCombo) {
			id = 'S' + current.ref.id;
		}

		for (let { target, type, fn, capture } of state.listeners) {
			target.removeEventListener(type, fn, capture);
		}
		for (let fn of state.cleanups) {
			try {
				fn();
			}
			catch (e) {
				Zotero.logError(e);
			}
		}
		for (let elem of state.elements) {
			elem.remove();
		}
		if (!cv) return;
		for (let [name, { hadOwn, value }] of Object.entries(state.originals)) {
			if (hadOwn) {
				cv[name] = value;
			}
			else {
				delete cv[name];
			}
		}
		if (!windowClosing && cv.tree) {
			this.updateProps(cv)
				.then(() => this.rebuild(cv, id, current?.ref?.libraryID))
				.catch(e => Zotero.logError(e));
		}
	},

	/**
	 * Zotero's saved search editor edits the whole name. Show only the search's own name there, and
	 * put the folder path and order prefix back when it's read, so renaming doesn't move the search.
	 * Typing a name that contains the separator still sets the full path on purpose.
	 *
	 * This is done on the name field itself, so the editor's "has changes" check and save
	 * (and Zotero's prompt when leaving with unsaved changes) keep working on the full name.
	 */
	patchSearchEditor(win, cv, state) {
		let field = win.document.querySelector('#zotero-saved-advanced-search-pane #saved-search-name');
		if (!field) {
			this.log('saved search editor not found');
			return;
		}
		let self = this;
		let native = Object.getOwnPropertyDescriptor(win.HTMLInputElement.prototype, 'value');
		let raw = native.get.call(field);
		Object.defineProperty(field, 'value', {
			configurable: true,
			enumerable: true,
			get() {
				return self.composeName(raw, native.get.call(field));
			},
			set(value) {
				raw = value;
				native.set.call(field, self.parse(value).leaf);
			}
		});
		state.cleanups.push(() => {
			let full = field.value;
			delete field.value;
			field.value = full;
		});

		// The editor also names the tab after the full stored name when saving
		let tabs = win.Zotero_Tabs;
		let rename = tabs.rename;
		tabs.rename = function (id, title, ...rest) {
			let row = id == 'zotero-pane' ? win.ZoteroPane.getCollectionTreeRows()[0] : null;
			if (row && row.isSearch() && row.ref.name === title) {
				title = row.getName();
			}
			return rename.call(this, id, title, ...rest);
		};
		state.cleanups.push(() => {
			tabs.rename = rename;
		});
	},

	/**
	 * Zotero's "Saved Search is" menu lists every search by its full stored name. Show the folders
	 * as submenus instead, in tree order and without the order prefixes. Only the layout changes:
	 * the menu values are still the search keys, so the condition is stored as Zotero would store it.
	 */
	patchSearchConditions(win, state) {
		// Zotero defines this element lazily, on first use
		win.document.createXULElement('zoterosearchcondition');
		let proto = win.customElements.get('zoterosearchcondition')?.prototype;
		if (!proto?.createValueMenu) {
			this.log('search condition element not found');
			return;
		}
		let self = this;
		let refresh = () => {
			for (let row of win.document.querySelectorAll('zoterosearchcondition')) {
				if (row.selectedCondition == 'savedSearch') {
					row.onConditionSelected('savedSearch', true);
				}
			}
		};
		let createValueMenu = proto.createValueMenu;
		proto.createValueMenu = function (rows) {
			if (this.selectedCondition != 'savedSearch') {
				createValueMenu.call(this, rows);
				return;
			}
			let libraryID = this.parent.search.libraryID;
			let searches = rows.map(row => Zotero.Searches.getByLibraryAndKey(libraryID, row.value.slice(1)));
			createValueMenu.call(this, rows.map((row, i) => ({ ...row, name: self.parse(searches[i].name).leaf })));
			self.nestSearchMenu(this.querySelector('#valuemenu'), searches, this.value);
		};
		state.cleanups.push(() => {
			proto.createValueMenu = createValueMenu;
			refresh();
		});

		let onCommand = (event) => {
			let item = event.target;
			let menu = item.closest?.('#valuemenu');
			if (menu && item.hasAttribute('data-ssf-path')) {
				this.selectSearchItem(menu, item);
			}
		};
		win.document.addEventListener('command', onCommand, true);
		state.listeners.push({ target: win.document, type: 'command', fn: onCommand, capture: true });

		refresh();
	},

	/** Move the flat items of a "Saved Search is" menu into submenus, and keep or set its selection */
	nestSearchMenu(menu, searches, value) {
		let doc = menu.ownerDocument;
		let popup = menu.menupopup;
		let items = new Map([...popup.children].map(item => [item.getAttribute('value'), item]));
		let current = items.get(value);
		let first = null;
		let fill = (node, parent, trail) => {
			for (let entry of this.children(node)) {
				if (entry.kind == 'folder') {
					let folder = doc.createXULElement('menu');
					folder.className = 'menu-iconic';
					folder.setAttribute('label', entry.name);
					folder.setAttribute('image', Zotero.Collection.prototype.treeViewImage);
					let submenu = doc.createXULElement('menupopup');
					folder.append(submenu);
					parent.append(folder);
					fill(entry.node, submenu, [...trail, entry.name]);
					continue;
				}
				let key = 'S' + entry.search.key;
				let item = items.get(key);
				item.setAttribute('data-ssf-path', [...trail, entry.name].join(' › '));
				parent.append(item);
				items.delete(key);
				first ??= item;
			}
		};
		fill(this.buildTree(searches.filter(s => !s.deleted)), popup, []);
		// Searches in the trash aren't in the tree, but a condition can still point to one
		for (let item of items.values()) {
			item.setAttribute('data-ssf-path', item.getAttribute('label'));
			popup.append(item);
		}

		let selected = current ?? first ?? popup.querySelector('menuitem');
		if (selected) {
			this.selectSearchItem(menu, selected);
		}
	},

	/**
	 * A menulist can't select an item in a submenu by itself, so do what its selection does by hand.
	 * The closed menu shows the whole path, since many searches can share a short name.
	 */
	selectSearchItem(menu, item) {
		menu.selectedItem = null;
		menu.querySelector('menuitem[selected]')?.removeAttribute('selected');
		item.setAttribute('selected', 'true');
		menu.setAttribute('value', item.getAttribute('value'));
		menu.setAttribute('label', item.getAttribute('data-ssf-path'));
		menu.setAttribute('image', item.getAttribute('image'));
	},

	/** Full search name for what was typed in the editor, given the name it started from */
	composeName(raw, typed) {
		typed = String(typed ?? '').trim();
		let p = this.parse(raw);
		if (typed === p.leaf) {
			return raw;
		}
		if (!typed || typed.includes(this.getSeparator())) {
			return typed;
		}
		// Keep the search's position, unless a new number was typed
		let m = String(p.leafRaw).trim().match(this.orderRegExp());
		let orderPrefix = m && p.order !== null && this.segmentOrder(typed) === null ? m[1] + this.getOrderSeparator() : '';
		return this.makeName(p.folderRaw, orderPrefix + typed);
	},

	addStyle(win, state) {
		let doc = win.document;
		let style = doc.createElementNS('http://www.w3.org/1999/xhtml', 'style');
		style.id = 'ssf-style';
		style.textContent = this.STYLE;
		(doc.head || doc.documentElement).appendChild(style);
		state.elements.push(style);
	},

	// ---------------------------------------------------------------------------------------
	// Patching the collection tree
	// ---------------------------------------------------------------------------------------

	patchTree(cv, state) {
		let self = this;
		let patch = (name, makeReplacement) => {
			let hadOwn = Object.prototype.hasOwnProperty.call(cv, name);
			let value = cv[name];
			state.originals[name] = { hadOwn, value };
			cv[name] = makeReplacement(value);
		};

		// Regroup saved-search rows under folder rows after Zotero has added them
		patch('_expandRow', orig => async function (rows, row, forceOpen) {
			let count = await orig.call(this, rows, row, forceOpen);
			try {
				let treeRow = rows[row];
				if (!count || !treeRow.isLibrary(true) || treeRow.isFeed()) {
					return count;
				}
				let level = treeRow.level + 1;
				let first = -1;
				let last = -1;
				for (let i = row + 1; i <= row + count; i++) {
					if (rows[i].level == level && rows[i].isSearch()) {
						if (first < 0) first = i;
						last = i;
					}
				}
				if (first < 0) {
					return count;
				}
				let searches = rows.slice(first, last + 1).filter(r => r.isSearch()).map(r => r.ref);
				let tree = self.buildTree(searches);
				let newRows = self.makeLibraryRows(this, tree, treeRow.ref.libraryID, level);
				rows.splice(first, last - first + 1, ...newRows);
				return count - (last - first + 1) + newRows.length;
			}
			catch (e) {
				Zotero.logError(e);
				return count;
			}
		});

		// Collection-pane filter support for folder rows
		patch('_matchesFilter', orig => function (object, resetCache) {
			if (object && object.ssfFolder) {
				if (this._isFilterEmpty()) {
					return { matchesFilter: true, hasChildMatchingFilter: true };
				}
				let matchesFilter = Zotero.Utilities.Internal.normalizeForSearch(object.name).includes(this._filter);
				let hasChildMatchingFilter = self.allSearchesIn(object.node).some((s) => {
					let r = orig.call(this, s, resetCache);
					return r.matchesFilter || r.hasChildMatchingFilter;
				});
				return { matchesFilter, hasChildMatchingFilter };
			}
			return orig.call(this, object, resetCache);
		});

		patch('getIconName', orig => function (index) {
			let row = this.getRow(index);
			if (self.isFolderRow(row)) {
				// Root "Saved Searches" folder: the saved-search glyph; other folders: a cyan folder
				return self.isRootRow(row) ? 'search' : 'collection';
			}
			return orig.call(this, index);
		});

		// Arrow-function properties (bound to the instance and passed to VirtualizedTable as props)
		patch('isContainerEmpty', orig => (index) => {
			if (self.isFolderRow(cv.getRow(index))) {
				return false;
			}
			return orig(index);
		});

		patch('toggleOpenState', orig => async (index) => {
			if (self.isFolderRow(cv.getRow(index))) {
				return self.toggleFolder(cv, index);
			}
			return orig(index);
		});

		patch('renderItem', orig => (index, selection, oldDiv, columns) => {
			let div = orig(index, selection, oldDiv, columns);
			try {
				let row = cv.getRow(index);
				let isFolder = self.isFolderRow(row);
				div.classList.toggle('ssf-folder', isFolder);
				if (!row) {
					return div;
				}
				self.renderDropIndicator(div, state, index);
				if (row.isSearch()) {
					let label = div.querySelector('.cell-text');
					if (label && label.localName != 'input') {
						label.textContent = self.parse(row.ref.name).leaf;
					}
					let termIndex = state.combo
						? state.combo.terms.findIndex(t => t.search.id == row.ref.id)
						: -1;
					if (termIndex >= 0 && label) {
						div.classList.add('ssf-combo-member');
						let badge = div.ownerDocument.createElement('span');
						badge.className = 'ssf-combo-badge';
						let op = state.combo.terms[termIndex].op;
						badge.textContent = op ? `${op} ${termIndex + 1}` : '1';
						label.after(badge);
					}
				}
			}
			catch (e) {
				Zotero.logError(e);
			}
			return div;
		});

		// Make sure a search inside closed folders is revealed before it gets selected
		patch('selectByID', orig => async function (id, ensureRowVisible = true) {
			// The combination row has its own ID, which Zotero itself doesn't know how to find
			if (state.comboRow && id === state.comboRow.id && this._rowMap[id] !== undefined) {
				let index = this._rowMap[id];
				if (ensureRowVisible) {
					this.ensureRowIsVisible(index);
				}
				await this.selectWait(index);
				return true;
			}
			if (typeof id == 'string' && id[0] == 'S') {
				try {
					let search = Zotero.Searches.get(parseInt(id.substr(1)));
					if (search && !search.deleted) {
						await this.expandLibrary(search.libraryID);
						await self.expandToSearch(this, search);
					}
				}
				catch (e) {
					Zotero.logError(e);
				}
			}
			return orig.call(this, id, ensureRowVisible);
		});

		// "+" key: also open all folders
		patch('expandLibrary', orig => async function (libraryID, recursive) {
			let result = await orig.call(this, libraryID, recursive);
			if (recursive && result) {
				for (let i = 0; i < this._rows.length; i++) {
					let row = this.getRow(i);
					if (self.isFolderRow(row) && row.ref.libraryID == libraryID && !row.isOpen) {
						await self.toggleFolder(this, i, true);
					}
				}
			}
			return result;
		});

		// Zotero inserts added/renamed searches at the library level, so rebuild instead
		patch('notify', orig => async function (action, type, ids, extraData) {
			if (type == 'search' && ['add', 'modify', 'delete'].includes(action)
					&& ids && ids.length && this._rowMap) {
				let current = this.getRow(this.selection.focused);
				let targetID = self.isFolderRow(current) ? null : current?.id;
				if (current?.ssfCombo) {
					targetID = 'S' + current.ref.id;
				}
				if (action == 'add' && ids.length == 1 && !extraData?.[ids[0]]?.skipSelect) {
					targetID = 'S' + ids[0];
				}
				await self.rebuild(this, targetID, current?.ref?.libraryID);
				// Zotero names the tab after the full stored name when a search is edited
				let selected = this.getRow(this.selection.focused);
				if (selected && selected.isSearch()) {
					this.window.Zotero_Tabs?.rename('zotero-pane', selected.getName());
				}
				return;
			}
			return orig.call(this, action, type, ids, extraData);
		});

		// Drop the combination as soon as something else gets selected
		let onSelect = () => {
			if (state.comboRow && cv.getRow(cv.selection.focused) !== state.comboRow) {
				this.restoreComboRow(cv, state);
			}
		};
		cv.onSelect.addListener(onSelect);
		state.cleanups.push(() => {
			cv.onSelect.removeListener(onSelect);
			this.restoreComboRow(cv, state);
		});
	},

	// ---------------------------------------------------------------------------------------
	// Combining saved searches (AND / OR)
	// ---------------------------------------------------------------------------------------

	comboExpression(combo) {
		let names = combo.terms.map(t => this.parse(t.search.name).leaf);
		let mixed = new Set(combo.terms.slice(1).map(t => t.op)).size > 1;
		let expr = names[0];
		for (let i = 1; i < names.length; i++) {
			expr = (mixed && i > 1 ? `(${expr})` : expr) + ` ${combo.terms[i].op} ${names[i]}`;
		}
		return expr;
	},

	/** Item IDs of the combination, evaluated left to right */
	async evaluateCombo(combo) {
		let result = null;
		for (let term of combo.terms) {
			let ids = new Set(await term.search.search());
			if (!result) {
				result = ids;
			}
			else if (term.op == 'AND') {
				result = new Set([...result].filter(id => ids.has(id)));
			}
			else {
				for (let id of ids) result.add(id);
			}
		}
		return [...(result || [])];
	},

	makeComboRow(cv, combo, level) {
		let self = this;
		let anchor = combo.terms[0].search;
		let row = new Zotero.CollectionTreeRow(cv, 'search', anchor, level);
		Object.defineProperty(row, 'id', {
			value: `S${anchor.id}:combo${++this._comboCounter}`,
			configurable: true
		});
		row.ssfCombo = combo;
		row.getName = () => this.comboExpression(combo);
		// Like Zotero's "Recently Read" view, results go through a temporary ID table. Zotero's own
		// code then adds the quick search, tag and advanced search filters on top of it.
		row.getSearchObject = async function (options = {}) {
			if (!options.unfiltered && this._cachedSearch) {
				return this._cachedSearch;
			}
			let ids = await self.evaluateCombo(combo);
			let tmpTable = await Zotero.Search.idsToTempTable(ids, { idColumn: 'id' });
			let s = new Zotero.Search();
			s.libraryID = combo.libraryID;
			s.addCondition('tempTable', 'is', tmpTable);
			let view = Object.create(this);
			view.ref = s;
			let search = await Zotero.CollectionTreeRow.prototype.getSearchObject.call(view, options);
			if (!options.unfiltered) {
				this._cachedSearch = search;
			}
			return search;
		};
		return row;
	},

	/** Put the plain search row back in place of the combination row (no selection change) */
	restoreComboRow(cv, state) {
		let comboRow = state.comboRow;
		let plain = state.comboPlainRow;
		state.combo = null;
		state.comboRow = null;
		state.comboPlainRow = null;
		if (!comboRow) return undefined;
		let index = cv._rowMap[comboRow.id];
		if (index !== undefined && cv._rows[index] === comboRow) {
			cv._rows[index] = plain || this.makeSearchRow(cv, comboRow.ref, comboRow.level);
			cv._refreshRowMap();
		}
		cv.tree?.invalidate();
		return index;
	},

	async applyCombo(cv, state, combo) {
		this.restoreComboRow(cv, state);
		let anchor = combo.terms[0].search;
		let index = cv._rowMap['S' + anchor.id];
		if (index === undefined) {
			await this.expandToSearch(cv, anchor);
			index = cv._rowMap['S' + anchor.id];
		}
		if (index === undefined) return;
		let plain = cv.getRow(index);
		let row = this.makeComboRow(cv, combo, plain.level);
		cv._rows[index] = row;
		cv._refreshRowMap();
		state.combo = combo;
		state.comboRow = row;
		state.comboPlainRow = plain;
		this.selectRowIndex(cv, index);
		cv.tree.invalidate();
	},

	async clearCombo(cv, state) {
		let index = this.restoreComboRow(cv, state);
		if (index !== undefined) {
			this.selectRowIndex(cv, index);
		}
	},

	/**
	 * Add `search` to the view with AND/OR, or remove it if it's already part of it
	 */
	async toggleComboMember(cv, state, search, op) {
		let current = cv.getRow(cv.selection.focused);
		if (!current || !current.isSearch() || current.ref.libraryID != search.libraryID) {
			return false;
		}
		let combo = state.combo
			? { libraryID: state.combo.libraryID, terms: state.combo.terms.slice() }
			: { libraryID: search.libraryID, terms: [{ search: current.ref, op: null }] };
		let i = combo.terms.findIndex(t => t.search.id == search.id);
		if (i >= 0) {
			combo.terms.splice(i, 1);
			if (combo.terms.length) {
				combo.terms[0] = { search: combo.terms[0].search, op: null };
			}
		}
		else {
			combo.terms.push({ search, op });
		}

		if (combo.terms.length >= 2) {
			await this.applyCombo(cv, state, combo);
		}
		else {
			this.restoreComboRow(cv, state);
			let remaining = combo.terms[0]?.search;
			let index = remaining ? cv._rowMap['S' + remaining.id] : undefined;
			if (index !== undefined) {
				this.selectRowIndex(cv, index);
			}
			else if (remaining) {
				await cv.selectByID('S' + remaining.id);
			}
		}
		return true;
	},

	/**
	 * A search's conditions, split into its match mode, its search-wide options, and its top-level
	 * "units" (a condition, or a whole nested group of them)
	 */
	searchUnits(search) {
		let mode = 'all';
		let flags = [];
		let units = [];
		let group = null;
		let depth = 0;
		for (let c of search.toJSON().conditions) {
			let base = c.condition.split('/')[0];
			let token = { condition: c.condition, operator: c.operator, value: c.value };
			if (base == 'groupStart') {
				if (!depth) {
					group = [];
					units.push(group);
				}
				depth++;
				group.push(token);
			}
			else if (base == 'groupEnd') {
				depth--;
				group.push(token);
			}
			else if (depth) {
				group.push(token);
			}
			else if (base == 'joinMode') {
				mode = c.operator;
			}
			else if (this.FLAG_CONDITIONS.includes(base)) {
				// The legacy "only top-level items" option is exactly result level = item
				flags.push(base == 'noChildren' && c.operator == 'true'
					? { condition: 'resultLevel', operator: 'item', value: '' }
					: token);
			}
			else {
				units.push([token]);
			}
		}
		return { mode, flags, units };
	},

	/**
	 * Build one condition list for a combination, nesting groups where needed. `termUnits` gives
	 * the mode and units to use for each search.
	 *
	 * @return {Object[]} Conditions, without the search-wide options
	 */
	comboConditions(combo, termUnits) {
		// Evaluated left to right: ((A op B) op C) ...
		let tree = null;
		for (let { search, op } of combo.terms) {
			if (!tree) {
				tree = { search };
			}
			else if (tree.op == op) {
				tree.kids.push({ search });
			}
			else {
				tree = { op, kids: [tree, { search }] };
			}
		}
		let wrap = (mode, units) => [[
			{ condition: 'groupStart', operator: 'true', value: '' },
			...(mode == 'any' ? [{ condition: 'joinMode', operator: 'any', value: '' }] : []),
			...units.flat(),
			{ condition: 'groupEnd', operator: 'true', value: '' }
		]];
		let serialize = (node, parentMode) => {
			if (node.search) {
				let { mode, units } = termUnits(node.search);
				return units.length <= 1 || mode == parentMode ? units : wrap(mode, units);
			}
			let mode = node.op == 'AND' ? 'all' : 'any';
			let seen = new Set();
			let units = node.kids.flatMap(kid => serialize(kid, mode)).filter((unit) => {
				let key = JSON.stringify(unit);
				return seen.has(key) ? false : seen.add(key);
			});
			return mode == parentMode ? units : wrap(mode, units);
		};
		let rootMode = tree.op == 'AND' ? 'all' : 'any';
		return [
			...(rootMode == 'any' ? [{ condition: 'joinMode', operator: 'any', value: '' }] : []),
			...serialize(tree, rootMode).flat()
		];
	},

	/**
	 * Merge the conditions of the combined searches into one self-contained condition list
	 *
	 * Any mix of AND and OR can be expressed with nested groups. What can't be merged are searches
	 * with different search-wide options, since those apply to a whole search.
	 *
	 * @return {{ ok: boolean, conditions?: object[], reason?: string }}
	 */
	mergeCombo(combo) {
		let flagsKey = null;
		let flags = new Map();
		let parts = new Map();
		for (let { search } of combo.terms) {
			let leaf = this.parse(search.name).leaf;
			let part = this.searchUnits(search);
			parts.set(search, part);
			// "Search subcollections" only affects Collection conditions
			let hasCollection = part.units.flat().some(c => c.condition.split('/')[0] == 'collection');
			let relevant = part.flags.filter(c => c.condition != 'recursive' || hasCollection);
			let key = relevant.map(c => `${c.condition}|${c.operator}`).sort().join(';');
			if (flagsKey === null) {
				flagsKey = key;
			}
			else if (key !== flagsKey) {
				return { ok: false, reason: `“${leaf}” uses different search options (such as the result level or “Include parent and child items”) than the others` };
			}
			for (let c of part.flags) {
				flags.set(c.condition, c);
			}
			if (!part.units.length && combo.terms.slice(1).some(t => t.op == 'OR')) {
				return { ok: false, reason: `“${leaf}” has no conditions` };
			}
		}
		return {
			ok: true,
			conditions: [...this.comboConditions(combo, search => parts.get(search)), ...flags.values()]
		};
	},

	/**
	 * Save the current combination as a new saved search with the merged conditions
	 */
	async saveCombo(win, cv, state, openEditor = true) {
		let combo = state.combo;
		if (!combo) return false;
		let merged = this.mergeCombo(combo);
		let conditions;
		if (merged.ok) {
			conditions = merged.conditions;
		}
		else {
			let ok = Services.prompt.confirm(win, 'Save Combination',
				`These searches can’t be merged into one self-contained saved search: ${merged.reason}.\n\n`
				+ 'Save a search that refers to the original saved searches instead? '
				+ '(It stops working if one of them is deleted.)');
			if (!ok) return false;
			conditions = this.comboConditions(combo, search => ({
				mode: 'all',
				units: [[{ condition: 'savedSearch', operator: 'is', value: search.key }]]
			}));
		}
		let anchor = combo.terms[0].search;
		let tree = this.buildTree(this.getSearches(combo.libraryID, true));
		let name = this.makeName(this.rawPathFor(tree, this.parse(anchor.name).folder), this.comboExpression(combo));
		return this.createSearch(win, combo.libraryID, name, conditions, openEditor);
	},

	/**
	 * Create a saved search, optionally selecting it and opening it in Zotero's search editor
	 */
	async createSearch(win, libraryID, name, conditions, openEditor) {
		if (Zotero.DB.inTransaction()) {
			await Zotero.DB.waitForTransaction();
		}
		let s = new Zotero.Search();
		s.libraryID = libraryID;
		s.fromJSON({ name, conditions });
		this.openFolderPath(libraryID, this.parse(s.name).folder);
		await s.saveTx();
		if (openEditor) {
			await win.ZoteroPane.collectionsView.selectByID('S' + s.id);
			await win.ZoteroPane.setSavedSearchEditorState('open');
		}
		return s;
	},

	// ---------------------------------------------------------------------------------------
	// Mouse, context menu and drag-and-drop
	// ---------------------------------------------------------------------------------------

	addListeners(win, cv, state) {
		let listen = (target, type, fn, capture = true) => {
			target.addEventListener(type, fn, capture);
			state.listeners.push({ target, type, fn, capture });
		};
		let rowFromEvent = (event) => {
			let div = event.target.closest?.('.row');
			if (!div || !div.id) return {};
			let m = div.id.match(/-row-(\d+)$/);
			if (!m) return {};
			let index = parseInt(m[1]);
			return { index, row: cv.getRow(index), div };
		};
		let domEl = cv.domEl;

		// Zotero 10 has its own multi-selection, handled on mouseup. For two saved searches,
		// Ctrl/Cmd+click means AND and Shift+click means OR instead. Anything else stays native.
		listen(domEl, 'mouseup', (event) => {
			if (event.button != 0 || event.altKey
					|| !(event.ctrlKey || event.metaKey || event.shiftKey)) {
				return;
			}
			let { row } = rowFromEvent(event);
			if (!row || !row.isSearch() || cv.selection.count != 1) return;
			let current = cv.getRow(cv.selection.focused);
			if (current && current.isSearch() && (current !== row || row === state.comboRow)
					&& current.ref.libraryID == row.ref.libraryID) {
				event.stopPropagation();
				this.toggleComboMember(cv, state, row.ref, event.shiftKey ? 'OR' : 'AND')
					.catch(e => this.showError(win, e));
			}
		});

		// Pressing the mouse on a row selects it right away, which would end the combination before
		// one of its members could be dragged. Zotero still selects it on mouseup if it's just a click.
		listen(domEl, 'mousedown', (event) => {
			if (event.button != 0 || event.ctrlKey || event.metaKey || event.shiftKey) return;
			let { row } = rowFromEvent(event);
			if (state.combo && row && row.isSearch() && row !== state.comboRow
					&& state.combo.terms.some(t => t.search.id == row.ref.id)) {
				event.stopPropagation();
			}
		});

		// Click anywhere on a folder row toggles it (the twisty handles its own clicks)
		listen(domEl, 'click', (event) => {
			if (event.button != 0) return;
			let { index, row } = rowFromEvent(event);
			if (this.isFolderRow(row) && !event.target.closest('.twisty')) {
				this.toggleFolder(cv, index);
			}
		});

		listen(domEl, 'contextmenu', (event) => {
			let { row } = rowFromEvent(event);
			state.contextSearch = row && row.isSearch() ? row.ref : null;
			if (this.isFolderRow(row)) {
				event.preventDefault();
				event.stopPropagation();
				this.openFolderMenu(win, cv, state, row, event.screenX, event.screenY);
				return;
			}
			// Right-click on another member of the combination: keep the combination selected
			if (state.combo && row && row.isSearch() && row !== state.comboRow
					&& state.combo.terms.some(t => t.search.id == row.ref.id)) {
				event.preventDefault();
				event.stopPropagation();
				win.ZoteroPane.onCollectionsContextMenuOpen(event, event.screenX, event.screenY);
			}
		});

		listen(domEl, 'dragstart', (event) => {
			let { row } = rowFromEvent(event);
			if (this.isRootRow(row)) {
				// The root folder stays where it is
				this._drag = null;
				event.preventDefault();
				event.stopPropagation();
			}
			else if (this.isFolderRow(row)) {
				this._drag = { type: 'folder', libraryID: row.ref.libraryID, path: row.ref.path };
				event.dataTransfer.setData('zotero/ssf-folder', JSON.stringify(this._drag));
				event.dataTransfer.effectAllowed = 'move';
				event.stopPropagation();
			}
			else if (row && row.isSearch()) {
				// Zotero handles the drag itself; remember what is being dragged. Dragging any member of
				// a Ctrl/Shift-click selection drags all of them, in the order they were selected.
				let searches = [row.ref];
				let group = state.combo && state.combo.terms.some(t => t.search.id == row.ref.id);
				if (group) {
					searches = state.combo.terms.map(t => t.search);
				}
				this._drag = { type: 'search', libraryID: row.ref.libraryID, searches, group };
				if (group) {
					// Zotero would select the dragged row, ending the combination
					event.dataTransfer.setData('zotero/ssf-searches', searches.map(s => s.id).join(','));
					event.dataTransfer.effectAllowed = 'move';
					event.stopPropagation();
				}
			}
			else {
				this._drag = null;
			}
		});

		// Drop indicator: a line above/below the row for before/after, Zotero's own highlight for
		// "into". Updated on the existing row elements, like Zotero does: re-rendering the row under
		// the pointer during a drag can keep it from getting a dragleave.
		let setIndicator = (indicator) => {
			let old = state.dropIndicator;
			if (old?.index === indicator?.index && old?.mode === indicator?.mode) return;
			state.dropIndicator = indicator;
			for (let index of new Set([old?.index, indicator?.index])) {
				let div = typeof index == 'number' ? cv.tree.getRowElement(index) : null;
				if (div) {
					this.renderDropIndicator(div, state, index);
				}
			}
			cv._setDropRow(indicator && indicator.mode == 'into' ? indicator.index : null);
		};
		let dropFraction = (event, div) => {
			let rect = div?.getBoundingClientRect();
			return rect && rect.height ? (event.clientY - rect.top) / rect.height : 0.5;
		};

		listen(win, 'dragend', () => {
			this._drag = null;
			if (state.dropIndicator) setIndicator(null);
		});

		listen(domEl, 'dragover', (event) => {
			if (!this._drag) return;
			let { index, row, div } = rowFromEvent(event);
			let target = this.getDropTarget(row, dropFraction(event, div));
			if (target && this.canDrop(this._drag, target)) {
				event.preventDefault();
				event.stopPropagation();
				cv.setDropEffect(event, 'move');
				setIndicator({ index, mode: target.mode });
			}
			else {
				if (state.dropIndicator) setIndicator(null);
				if (this._drag.type == 'folder' || this._drag.group) {
					// Nothing else in the tree accepts these
					event.stopPropagation();
					event.dataTransfer.dropEffect = 'none';
				}
			}
		});

		listen(domEl, 'dragleave', (event) => {
			if (state.dropIndicator && !domEl.contains(event.relatedTarget)) {
				setIndicator(null);
			}
		});

		listen(domEl, 'drop', (event) => {
			let drag = this._drag;
			if (!drag) return;
			let { row, div } = rowFromEvent(event);
			let target = this.getDropTarget(row, dropFraction(event, div));
			if (!target || !this.canDrop(drag, target)) return;
			event.preventDefault();
			event.stopPropagation();
			this._drag = null;
			setIndicator(null);
			Zotero.DragDrop.currentDropEffect = null;
			this.dropEntry(drag, target).catch(e => this.showError(win, e));
		});
	},

	renderDropIndicator(div, state, index) {
		let mode = state.dropIndicator?.index === index ? state.dropIndicator.mode : null;
		div.classList.toggle('ssf-drop-before', mode == 'before');
		div.classList.toggle('ssf-drop-after', mode == 'after' || mode == 'into-first');
	},

	/**
	 * Where a drop onto `row` would put the dragged search/folder
	 *
	 * Search rows: top half = before, bottom half = after.
	 * Folder rows: top quarter = before, bottom quarter = after (or first inside, if open),
	 * middle = into the folder. Library rows: into the top level.
	 *
	 * @param {Number} [fraction] - Vertical drop position within the row (0 = top, 1 = bottom)
	 * @return {?{ libraryID: Number, mode: String, path?: String[], parentPath?: String[], entry?: Object }}
	 */
	getDropTarget(row, fraction = 0.5) {
		if (!row) return null;
		if (this.isRootRow(row)) {
			let { libraryID } = row.ref;
			return fraction > 0.75 && row.isOpen
				? { libraryID, mode: 'into-first', path: [] }
				: { libraryID, mode: 'into', path: [] };
		}
		if (this.isFolderRow(row)) {
			let { libraryID, path, name } = row.ref;
			let entry = { kind: 'folder', name };
			if (fraction < 0.25) {
				return { libraryID, mode: 'before', parentPath: path.slice(0, -1), entry };
			}
			if (fraction > 0.75) {
				return row.isOpen
					? { libraryID, mode: 'into-first', path }
					: { libraryID, mode: 'after', parentPath: path.slice(0, -1), entry };
			}
			return { libraryID, mode: 'into', path };
		}
		if (row.isSearch()) {
			return {
				libraryID: row.ref.libraryID,
				mode: fraction < 0.5 ? 'before' : 'after',
				parentPath: this.parse(row.ref.name).folder,
				entry: { kind: 'search', id: row.ref.id }
			};
		}
		if (row.isLibrary() || row.isGroup()) {
			return { libraryID: row.ref.libraryID, mode: 'into', path: [] };
		}
		return null;
	},

	/** Folder the dragged entry ends up in */
	destinationPath(target) {
		return target.mode == 'into' || target.mode == 'into-first' ? target.path : target.parentPath;
	},

	canDrop(drag, target) {
		if (!this.isLibraryEditable(target.libraryID)) return false;
		if (drag.libraryID != target.libraryID) return false;
		let dest = this.destinationPath(target);
		if (drag.type == 'search') {
			if (target.mode == 'into') {
				return drag.searches.some(s => !this.pathEquals(this.parse(s.name).folder, dest));
			}
			return !(target.entry?.kind == 'search' && drag.searches.some(s => s.id == target.entry.id));
		}
		if (drag.type == 'folder') {
			// Not into itself or one of its subfolders
			if (this.pathStartsWith(dest, drag.path)) return false;
			let parent = drag.path.slice(0, -1);
			if (target.mode == 'into') {
				return !this.pathEquals(parent, dest);
			}
			return !(target.entry?.kind == 'folder' && this.pathEquals(parent, dest)
				&& target.entry.name == drag.path[drag.path.length - 1]);
		}
		return false;
	},

	/**
	 * Move the dragged searches/folder to the drop target's folder and, for before/after drops,
	 * number the new siblings so they land exactly there
	 */
	async dropEntry(drag, target) {
		let libraryID = target.libraryID;
		let dest = this.destinationPath(target);
		let folderName = drag.type == 'folder' ? drag.path[drag.path.length - 1] : null;
		let ids = new Set(drag.type == 'search' ? drag.searches.map(s => s.id) : []);
		if (drag.type == 'search') {
			await this.moveSearches(drag.searches, dest);
		}
		else if (!this.pathEquals(drag.path.slice(0, -1), dest)) {
			await this.moveFolder(libraryID, drag.path, dest);
		}
		let isDragged = e => (drag.type == 'search'
			? e.kind == 'search' && ids.has(e.search.id)
			: e.kind == 'folder' && e.name == folderName);
		if (target.mode == 'into') {
			await this.placeAtEnd(libraryID, dest, isDragged);
			return;
		}

		let parent = this.nodeAt(this.buildTree(this.getSearches(libraryID)), dest);
		if (!parent) return;
		let entries = this.children(parent);
		let dragged = entries.filter(isDragged);
		if (!dragged.length) return;
		if (drag.type == 'search') {
			// Keep the order in which they were selected
			dragged = drag.searches.map(s => dragged.find(e => e.search.id == s.id)).filter(Boolean);
		}
		entries = entries.filter(e => !isDragged(e));
		let index = 0;
		if (target.mode != 'into-first') {
			let t = target.entry;
			let targetIndex = entries.findIndex(e => e.kind == t.kind
				&& (t.kind == 'search' ? e.search.id == t.id : e.name == t.name));
			if (targetIndex < 0) return;
			index = targetIndex + (target.mode == 'after' ? 1 : 0);
		}
		entries.splice(index, 0, ...dragged);
		await this.applyOrder(libraryID, dest, entries, true);
	},

	isLibraryEditable(libraryID) {
		let library = Zotero.Libraries.get(libraryID);
		return !!(library && library.editable);
	},

	// ---------------------------------------------------------------------------------------
	// Menus
	// ---------------------------------------------------------------------------------------

	createMenuItem(doc, label, oncommand, attrs = {}) {
		let item = doc.createXULElement('menuitem');
		item.setAttribute('label', label);
		for (let [k, v] of Object.entries(attrs)) {
			item.setAttribute(k, v);
		}
		if (oncommand) {
			item.addEventListener('command', (event) => {
				event.stopPropagation();
				oncommand(event);
			});
		}
		return item;
	},

	createSubmenu(doc, label) {
		let menu = doc.createXULElement('menu');
		menu.setAttribute('label', label);
		let popup = doc.createXULElement('menupopup');
		menu.appendChild(popup);
		return { menu, popup };
	},

	formatPath(path) {
		return path.join(' › ');
	},

	/** Position of an entry among its siblings, for Move Up/Down */
	siblingInfo(libraryID, parentPath, match) {
		let parent = this.nodeAt(this.buildTree(this.getSearches(libraryID)), parentPath);
		let entries = parent ? this.children(parent) : [];
		let index = entries.findIndex(match);
		return { entries, index, canUp: index > 0, canDown: index >= 0 && index < entries.length - 1 };
	},

	addMenus(win, cv, state) {
		let doc = win.document;

		// Context menu for folder rows
		let folderMenu = doc.createXULElement('menupopup');
		folderMenu.id = 'ssf-folder-menu';
		(doc.getElementById('mainPopupSet') || doc.querySelector('popupset') || doc.documentElement)
			.appendChild(folderMenu);
		state.elements.push(folderMenu);

		// Additions to Zotero's collection context menu; rebuilt every time it opens
		let collectionMenu = doc.getElementById('zotero-collectionmenu');
		if (!collectionMenu) return;
		let added = [];
		let onShowing = (event) => {
			if (event.target != collectionMenu) return;
			for (let elem of added) elem.remove();
			added = this.buildCollectionMenuItems(win, cv, state);
			if (added.length) {
				added.unshift(doc.createXULElement('menuseparator'));
			}
			for (let elem of added) {
				elem.classList.add('ssf-menu-item');
				collectionMenu.appendChild(elem);
			}
		};
		let onHidden = (event) => {
			if (event.target == collectionMenu) {
				state.contextSearch = null;
			}
		};
		collectionMenu.addEventListener('popupshowing', onShowing);
		collectionMenu.addEventListener('popuphidden', onHidden);
		state.listeners.push(
			{ target: collectionMenu, type: 'popupshowing', fn: onShowing, capture: false },
			{ target: collectionMenu, type: 'popuphidden', fn: onHidden, capture: false }
		);
		state.cleanups.push(() => {
			for (let elem of added) elem.remove();
		});
	},

	buildCollectionMenuItems(win, cv, state) {
		let doc = win.document;
		let items = [];
		// With several rows selected (Zotero's own multi-selection), leave the menu as it is
		let rows = win.ZoteroPane.getCollectionTreeRows();
		if (rows.length != 1) return items;
		let row = rows[0];
		let run = fn => () => fn().catch(e => this.showError(win, e));

		// Library: new folder, sort top level
		if ((row.isLibrary() || row.isGroup()) && row.ref.libraryID) {
			let libraryID = row.ref.libraryID;
			let attrs = this.isLibraryEditable(libraryID) ? {} : { disabled: 'true' };
			items.push(this.createMenuItem(doc, 'New Saved Search…',
				run(() => this.newSearchInFolder(win, libraryID, [])), attrs));
			items.push(this.createMenuItem(doc, 'New Search Folder…',
				run(() => this.newFolder(win, libraryID, [])), attrs));
			let hasOrder = this.siblingInfo(libraryID, [], () => false).entries.some(e => e.order !== null);
			items.push(this.createMenuItem(doc, 'Sort Saved Searches Alphabetically',
				run(() => this.sortAlphabetically(libraryID, [])), hasOrder ? attrs : { disabled: 'true' }));
			return items;
		}
		if (!row.isSearch() || row.ref.deleted) return items;

		// The search the menu is about: the right-clicked combination member, or the selected search
		let search = state.contextSearch || row.ref;
		let libraryID = search.libraryID;
		let editable = this.isLibraryEditable(libraryID);
		let attrs = editable ? {} : { disabled: 'true' };
		let parsed = this.parse(search.name);

		// Combination
		let members = new Set(state.combo ? state.combo.terms.map(t => t.search.id) : [row.ref.id]);
		for (let op of ['AND', 'OR']) {
			let { menu, popup } = this.createSubmenu(doc, `Add Saved Search with ${op}`);
			popup.addEventListener('popupshowing', (event) => {
				if (event.target != popup) return;
				this.fillSearchPicker(doc, popup, this.buildTree(this.getSearches(libraryID)), members,
					picked => this.toggleComboMember(cv, state, picked, op).catch(e => this.showError(win, e)));
			});
			items.push(menu);
		}
		if (state.combo) {
			if (state.contextSearch && members.has(state.contextSearch.id)) {
				let contextSearch = state.contextSearch;
				let name = this.parse(contextSearch.name).leaf;
				items.push(this.createMenuItem(doc, `Remove “${name}” from Combination`,
					run(() => this.toggleComboMember(cv, state, contextSearch, 'AND'))));
			}
			items.push(this.createMenuItem(doc, 'Save Combination as Saved Search…',
				run(() => this.saveCombo(win, cv, state)), attrs));
			items.push(this.createMenuItem(doc, 'Clear Combination', run(() => this.clearCombo(cv, state))));
		}
		items.push(doc.createXULElement('menuseparator'));

		// Folder & order
		let { menu: moveMenu, popup: movePopup } = this.createSubmenu(doc, 'Move to Search Folder');
		if (!editable) moveMenu.setAttribute('disabled', 'true');
		movePopup.addEventListener('popupshowing', (event) => {
			if (event.target == movePopup) this.fillMoveMenu(win, movePopup, search);
		});
		items.push(moveMenu);

		let info = this.siblingInfo(libraryID, parsed.folder, e => e.kind == 'search' && e.search.id == search.id);
		items.push(this.createMenuItem(doc, 'Move Up',
			run(() => this.moveEntry(libraryID, parsed.folder, info.index, -1)),
			editable && info.canUp ? {} : { disabled: 'true' }));
		items.push(this.createMenuItem(doc, 'Move Down',
			run(() => this.moveEntry(libraryID, parsed.folder, info.index, 1)),
			editable && info.canDown ? {} : { disabled: 'true' }));
		return items;
	},

	/** Nested menu of all saved searches in a library */
	fillSearchPicker(doc, popup, node, disabledIDs, onPick) {
		popup.replaceChildren();
		for (let entry of this.children(node)) {
			if (entry.kind == 'folder') {
				let { menu, popup: sub } = this.createSubmenu(doc, entry.name);
				this.fillSearchPicker(doc, sub, entry.node, disabledIDs, onPick);
				if (sub.childElementCount) {
					popup.appendChild(menu);
				}
			}
			else {
				popup.appendChild(this.createMenuItem(doc, entry.name, () => onPick(entry.search),
					disabledIDs.has(entry.search.id) ? { disabled: 'true' } : {}));
			}
		}
	},

	fillMoveMenu(win, popup, search) {
		let doc = win.document;
		popup.replaceChildren();
		let current = this.parse(search.name).folder;
		let move = (path, hints) => () => this.moveSearchToEnd(search, path, hints).catch(e => this.showError(win, e));

		popup.appendChild(this.createMenuItem(doc, '(Top level)', move([]),
			current.length ? {} : { disabled: 'true' }));
		let paths = this.getFolderPaths(search.libraryID);
		if (paths.length) {
			popup.appendChild(doc.createXULElement('menuseparator'));
		}
		for (let path of paths) {
			let label = ' '.repeat(path.length - 1) + path[path.length - 1];
			let attrs = { tooltiptext: this.formatPath(path) };
			if (this.pathEquals(path, current)) {
				attrs.disabled = 'true';
			}
			popup.appendChild(this.createMenuItem(doc, label, move(path), attrs));
		}
		popup.appendChild(doc.createXULElement('menuseparator'));
		popup.appendChild(this.createMenuItem(doc, 'New Folder…', () => {
			let raw = this.promptForPath(win, 'New Search Folder',
				`Folder name (use "${this.getSeparator()}" to create nested folders):`, '');
			if (raw) {
				move(raw.map(s => this.segmentName(s)), raw)();
			}
		}));
	},

	openFolderMenu(win, cv, state, row, x, y) {
		let doc = win.document;
		let popup = doc.getElementById('ssf-folder-menu');
		if (!popup) return;
		let { libraryID, path } = row.ref;
		let editable = this.isLibraryEditable(libraryID);
		let attrs = editable ? {} : { disabled: 'true' };
		let run = fn => () => fn().catch(e => this.showError(win, e));
		let parentPath = path.slice(0, -1);
		let info = this.siblingInfo(libraryID, parentPath, e => e.kind == 'folder' && e.name == row.ref.name);
		let hasOrder = this.children(row.ref.node).some(e => e.order !== null);
		popup.replaceChildren();

		if (this.isRootRow(row)) {
			popup.appendChild(this.createMenuItem(doc, 'New Saved Search…',
				run(() => this.newSearchInFolder(win, libraryID, [])), attrs));
			popup.appendChild(this.createMenuItem(doc, 'New Search Folder…',
				run(() => this.newFolder(win, libraryID, [])), attrs));
			popup.appendChild(doc.createXULElement('menuseparator'));
			popup.appendChild(this.createMenuItem(doc, 'Sort Alphabetically',
				run(() => this.sortAlphabetically(libraryID, [])), editable && hasOrder ? {} : { disabled: 'true' }));
			popup.openPopupAtScreen(x + (Zotero.isWin ? 10 : 0), y, true);
			return;
		}

		popup.appendChild(this.createMenuItem(doc, 'New Saved Search in Folder…',
			run(() => this.newSearchInFolder(win, libraryID, path)), attrs));
		popup.appendChild(this.createMenuItem(doc, 'New Subfolder…',
			run(() => this.newFolder(win, libraryID, path)), attrs));
		popup.appendChild(doc.createXULElement('menuseparator'));
		popup.appendChild(this.createMenuItem(doc, 'Move Up',
			run(() => this.moveEntry(libraryID, parentPath, info.index, -1)),
			editable && info.canUp ? {} : { disabled: 'true' }));
		popup.appendChild(this.createMenuItem(doc, 'Move Down',
			run(() => this.moveEntry(libraryID, parentPath, info.index, 1)),
			editable && info.canDown ? {} : { disabled: 'true' }));
		popup.appendChild(this.createMenuItem(doc, 'Sort Contents Alphabetically',
			run(() => this.sortAlphabetically(libraryID, path)), editable && hasOrder ? {} : { disabled: 'true' }));
		popup.appendChild(doc.createXULElement('menuseparator'));
		popup.appendChild(this.createMenuItem(doc, 'Rename Folder…', run(async () => {
			let raw = this.promptForPath(win, 'Rename Search Folder',
				`New name (use "${this.getSeparator()}" to nest it):`, row.ref.name);
			if (raw) {
				await this.renameFolderPrefix(libraryID, path, parentPath.concat(raw.map(s => this.segmentName(s))),
					{ carryOrder: true, hints: parentPath.concat(raw) });
			}
		}), attrs));
		if (path.length > 1) {
			popup.appendChild(this.createMenuItem(doc, 'Move Folder to Top Level',
				run(() => this.moveFolder(libraryID, path, [])), attrs));
		}
		popup.appendChild(this.createMenuItem(doc, 'Ungroup Folder (keep searches)',
			run(() => this.renameFolderPrefix(libraryID, path, parentPath)), attrs));
		popup.appendChild(doc.createXULElement('menuseparator'));
		popup.appendChild(this.createMenuItem(doc, 'Move Folder and Its Searches to Trash…',
			run(() => this.trashFolder(win, libraryID, path)), attrs));

		popup.openPopupAtScreen(x + (Zotero.isWin ? 10 : 0), y, true);
	},

	/** @return {string[]|null} Raw path segments as typed */
	promptForPath(win, title, text, defaultValue) {
		let value = { value: defaultValue };
		if (!Services.prompt.prompt(win, title, text, value, null, {})) {
			return null;
		}
		let path = this.splitPath(value.value);
		return path.length ? path : null;
	},

	showError(win, e) {
		Zotero.logError(e);
		Services.prompt.alert(win, 'Saved Search Folders', String(e && e.message || e));
	},

	// ---------------------------------------------------------------------------------------
	// Data operations (all done by renaming saved searches)
	// ---------------------------------------------------------------------------------------

	async saveNames(changes) {
		changes = [...changes].filter(([search, name]) => name != search.name);
		if (!changes.length) return;
		await Zotero.DB.executeTransaction(async () => {
			for (let [search, name] of changes) {
				search.name = name;
				await search.save();
			}
		});
	},

	async moveSearch(search, folderPath, hints = []) {
		await this.moveSearches([search], folderPath, hints);
	},

	/** Move searches into a folder in one transaction (so the tree is only rebuilt once) */
	async moveSearches(searches, folderPath, hints = []) {
		if (!searches.length) return;
		let libraryID = searches[0].libraryID;
		let tree = this.buildTree(this.getSearches(libraryID, true));
		let folderRaw = this.rawPathFor(tree, folderPath, hints);
		let changes = new Map();
		for (let search of searches) {
			changes.set(search, this.makeName(folderRaw, this.parse(search.name).leafRaw));
		}
		this.openFolderPath(libraryID, folderPath);
		await this.saveNames(changes);
	},

	/**
	 * After moving entries into a folder, put them last: drop their old position numbers, or number
	 * them after the others if that folder already has a custom order
	 */
	async placeAtEnd(libraryID, parentPath, isEntry) {
		let parent = this.nodeAt(this.buildTree(this.getSearches(libraryID)), parentPath);
		if (!parent) return;
		let entries = this.children(parent);
		let moved = entries.filter(isEntry);
		if (!moved.length) return;
		let others = entries.filter(e => !isEntry(e));
		if (others.some(e => e.order !== null)) {
			await this.applyOrder(libraryID, parentPath, others.concat(moved), true);
		}
		else if (moved.some(e => e.order !== null)) {
			await this.applyOrder(libraryID, parentPath, moved, false);
		}
	},

	/** "Move to Search Folder" menu: move and put it at the end of that folder */
	async moveSearchToEnd(search, folderPath, hints = []) {
		await this.moveSearch(search, folderPath, hints);
		await this.placeAtEnd(search.libraryID, this.parse(search.name).folder,
			e => e.kind == 'search' && e.search.id == search.id);
	},

	async moveFolder(libraryID, path, targetParentPath) {
		let newPath = targetParentPath.concat(path[path.length - 1]);
		await this.renameFolderPrefix(libraryID, path, newPath, { carryOrder: true });
	},

	/**
	 * Replace the folder prefix `oldPath` with `newPath` (display paths) in every saved search below it
	 *
	 * @param {Object} [options]
	 * @param {Boolean} [options.carryOrder] - Keep the folder's "N_" order prefix (rename/move)
	 * @param {String[]} [options.hints] - Raw spelling for new path segments, as typed by the user
	 */
	async renameFolderPrefix(libraryID, oldPath, newPath, { carryOrder = false, hints = [] } = {}) {
		if (this.pathEquals(oldPath, newPath)) return;
		let all = this.getSearches(libraryID, true);
		let tree = this.buildTree(all);
		let oldNode = this.nodeAt(tree, oldPath);
		if (!oldNode) return;

		let newRaw = this.rawPathFor(tree, newPath.slice(0, -1), hints);
		if (newPath.length) {
			let last = newPath[newPath.length - 1];
			let hint = hints[newPath.length - 1];
			let existing = this.nodeAt(tree, newPath);
			if (existing && existing !== oldNode) {
				newRaw.push(existing.raw);
			}
			else if (hint && this.segmentOrder(hint) !== null) {
				newRaw.push(hint);
			}
			else {
				newRaw.push(carryOrder ? this.withOrder(last, oldNode.order) : last);
			}
		}

		let changes = new Map();
		for (let search of all) {
			let { folder, folderRaw, leafRaw } = this.parse(search.name);
			if (!folder.length || !this.pathStartsWith(folder, oldPath)) continue;
			changes.set(search, this.makeName(newRaw.concat(folderRaw.slice(oldPath.length)), leafRaw));
		}
		if (newPath.length) {
			this.moveOpenStates(libraryID, oldPath, newPath);
			this.openFolderPath(libraryID, newPath.slice(0, -1));
		}
		await this.saveNames(changes);
	},

	/**
	 * Move the entry at `index` among the children of `parentPath` up/down by one,
	 * numbering all siblings (1_, 2_, …) so the order also holds in a plain sorted list
	 */
	async moveEntry(libraryID, parentPath, index, delta) {
		let parent = this.nodeAt(this.buildTree(this.getSearches(libraryID)), parentPath);
		if (!parent) return;
		let entries = this.children(parent);
		let target = index + delta;
		if (index < 0 || target < 0 || target >= entries.length) return;
		[entries[index], entries[target]] = [entries[target], entries[index]];
		await this.applyOrder(libraryID, parentPath, entries, true);
	},

	async sortAlphabetically(libraryID, parentPath) {
		let parent = this.nodeAt(this.buildTree(this.getSearches(libraryID)), parentPath);
		if (!parent) return;
		await this.applyOrder(libraryID, parentPath, this.children(parent), false);
	},

	/** Rewrite the order prefix of each entry (or remove it when `numbered` is false) */
	async applyOrder(libraryID, parentPath, entries, numbered) {
		let width = String(entries.length).length;
		let all = this.getSearches(libraryID, true);
		let changes = new Map();
		let depth = parentPath.length;
		entries.forEach((entry, i) => {
			let segment = this.withOrder(entry.name, numbered ? i + 1 : null, width);
			if (entry.kind == 'search') {
				let p = this.parse(changes.get(entry.search) ?? entry.search.name);
				changes.set(entry.search, this.makeName(p.folderRaw, segment));
				return;
			}
			let folderPath = parentPath.concat(entry.name);
			for (let search of all) {
				let p = this.parse(changes.get(search) ?? search.name);
				if (!this.pathStartsWith(p.folder, folderPath)) continue;
				let folderRaw = p.folderRaw.slice();
				folderRaw[depth] = segment;
				changes.set(search, this.makeName(folderRaw, p.leafRaw));
			}
		});
		await this.saveNames(changes);
	},

	async trashFolder(win, libraryID, path) {
		let searches = this.getSearches(libraryID).filter(
			s => this.pathStartsWith(this.parse(s.name).folder, path)
		);
		if (!searches.length) return;
		let ok = Services.prompt.confirm(win, 'Move to Trash',
			`Move the folder "${this.formatPath(path)}" and its ${searches.length} saved search(es) to the trash?`);
		if (!ok) return;
		await Zotero.DB.executeTransaction(async () => {
			for (let search of searches) {
				search.deleted = true;
				await search.save();
			}
		});
	},

	nextUntitledName(libraryID, path) {
		let prefix = Zotero.getString('pane.collections.untitled');
		let existing = this.getSearches(libraryID)
			.map(search => this.parse(search.name))
			.filter(p => this.pathEquals(p.folder, path) && p.leaf.startsWith(prefix))
			.map(p => p.leaf);
		return Zotero.Utilities.Internal.getNextName(prefix, existing);
	},

	/**
	 * Create a folder (asking only for its name) with a blank "Untitled" search in it,
	 * since a folder only exists while it contains a saved search
	 */
	async newFolder(win, libraryID, parentPath, rawName) {
		let raw = rawName ? this.splitPath(rawName) : this.promptForPath(win,
			parentPath.length ? 'New Subfolder' : 'New Search Folder',
			`Folder name (use "${this.getSeparator()}" to create nested folders):`, '');
		if (!raw) return false;
		let path = parentPath.concat(raw.map(s => this.segmentName(s)));
		let tree = this.buildTree(this.getSearches(libraryID, true));
		let folderRaw = this.rawPathFor(tree, path, parentPath.map(() => null).concat(raw));
		let name = this.makeName(folderRaw, this.nextUntitledName(libraryID, path));
		return this.createSearch(win, libraryID, name, this.BLANK_CONDITIONS, false);
	},

	/** Create a blank search in a folder and open it in Zotero's search editor */
	async newSearchInFolder(win, libraryID, path) {
		let tree = this.buildTree(this.getSearches(libraryID, true));
		let name = this.makeName(this.rawPathFor(tree, path), this.nextUntitledName(libraryID, path));
		return this.createSearch(win, libraryID, name, this.BLANK_CONDITIONS, true);
	}
};
