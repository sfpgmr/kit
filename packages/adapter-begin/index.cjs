'use strict';

Object.defineProperty(exports, '__esModule', { value: true });

function index () {
	/** @type {import('@sveltejs/kit').Adapter} */
	const adapter = {
		name: '@sveltejs/adapter-begin',

		async adapt() {
			console.log('@sveltejs/adapter-begin can now be found at architect/sveltekit-adapter.');
		}
	};

	return adapter;
}

exports["default"] = index;
//# sourceMappingURL=index.cjs.map
