import { readFileSync, writeFileSync } from 'fs';
import { dirname, join, resolve as resolve_path } from 'path';
import { pathToFileURL, URL } from 'url';
import { mkdirp } from '../../../utils/filesystem.js';
import { __fetch_polyfill } from '../../../install-fetch.js';
import { SVELTE_KIT } from '../../constants.js';
import { is_root_relative, normalize_path, resolve } from '../../../utils/url.js';
import { queue } from './queue.js';
import { crawl } from './crawl.js';
import { escape_html_attr } from '../../../utils/escape.js';

/**
 * @typedef {import('types/config').PrerenderErrorHandler} PrerenderErrorHandler
 * @typedef {import('types/config').PrerenderOnErrorValue} OnError
 * @typedef {import('types/internal').Logger} Logger
 */

/** @type {(details: Parameters<PrerenderErrorHandler>[0] ) => string} */
function format_error({ status, path, referrer, referenceType }) {
	return `${status} ${path}${referrer ? ` (${referenceType} from ${referrer})` : ''}`;
}

/** @type {(log: Logger, onError: OnError) => PrerenderErrorHandler} */
function normalise_error_handler(log, onError) {
	switch (onError) {
		case 'continue':
			return (details) => {
				log.error(format_error(details));
			};
		case 'fail':
			return (details) => {
				throw new Error(format_error(details));
			};
		default:
			return onError;
	}
}

const OK = 2;
const REDIRECT = 3;

/**
 * @param {{
 *   cwd: string;
 *   out: string;
 *   log: Logger;
 *   config: import('types/config').ValidatedConfig;
 *   build_data: import('types/internal').BuildData;
 *   fallback?: string;
 *   all: boolean; // disregard `export const prerender = true`
 * }} opts
 */
export async function prerender({ cwd, out, log, config, build_data, fallback, all }) {
	/** @type {import('types/config').Prerendered} */
	const prerendered = {
		pages: new Map(),
		assets: new Map(),
		redirects: new Map(),
		paths: []
	};

	if (!config.kit.prerender.enabled && !fallback) {
		return prerendered;
	}

	__fetch_polyfill();

	const server_root = resolve_path(cwd, `${SVELTE_KIT}/output`);

	/** @type {import('types/internal').AppModule} */
	const { App, override } = await import(pathToFileURL(`${server_root}/server/app.js`).href);
	const { manifest } = await import(pathToFileURL(`${server_root}/server/manifest.js`).href);

	override({
		paths: config.kit.paths,
		prerendering: true,
		read: (file) => readFileSync(join(config.kit.files.assets, file))
	});

	const app = new App(manifest);

	const error = normalise_error_handler(log, config.kit.prerender.onError);

	const files = new Set([
		...build_data.static,
		...build_data.client.chunks.map((chunk) => `${config.kit.appDir}/${chunk.fileName}`),
		...build_data.client.assets.map((chunk) => `${config.kit.appDir}/${chunk.fileName}`)
	]);

	build_data.static.forEach((file) => {
		if (file.endsWith('/index.html')) {
			files.add(file.slice(0, -11));
		}
	});

	const q = queue(config.kit.prerender.concurrency);

	/**
	 * @param {string} path
	 * @param {boolean} is_html
	 */
	function output_filename(path, is_html) {
		const file = path.slice(config.kit.paths.base.length + 1);

		if (file === '') {
			return 'index.html';
		}

		if (is_html && !file.endsWith('.html')) {
			return file + (config.kit.trailingSlash === 'always' ? 'index.html' : '.html');
		}

		return file;
	}

	const seen = new Set();
	const written = new Set();

	/**
	 * @param {string | null} referrer
	 * @param {string} decoded
	 * @param {string} [encoded]
	 */
	function enqueue(referrer, decoded, encoded) {
		if (seen.has(decoded)) return;
		seen.add(decoded);

		const file = decoded.slice(config.kit.paths.base.length + 1);
		if (files.has(file)) return;

		return q.add(() => visit(decoded, encoded || encodeURI(decoded), referrer));
	}

	/**
	 * @param {string} decoded
	 * @param {string} encoded
	 * @param {string?} referrer
	 */
	async function visit(decoded, encoded, referrer) {
		if (!decoded.startsWith(config.kit.paths.base)) {
			error({ status: 404, path: decoded, referrer, referenceType: 'linked' });
			return;
		}

		/** @type {Map<string, import('types/internal').PrerenderDependency>} */
		const dependencies = new Map();

		const response = await app.render(new Request(`http://sveltekit-prerender${encoded}`), {
			prerender: {
				all,
				dependencies
			}
		});

		const text = await response.text();

		save(response, text, decoded, encoded, referrer, 'linked');

		for (const [dependency_path, result] of dependencies) {
			// this seems circuitous, but using new URL allows us to not care
			// whether dependency_path is encoded or not
			const encoded_dependency_path = new URL(dependency_path, 'http://localhost').pathname;
			const decoded_dependency_path = decodeURI(encoded_dependency_path);

			const body = result.body ?? new Uint8Array(await result.response.arrayBuffer());
			save(
				result.response,
				body,
				decoded_dependency_path,
				encoded_dependency_path,
				decoded,
				'fetched'
			);
		}

		if (config.kit.prerender.crawl && response.headers.get('content-type') === 'text/html') {
			for (const href of crawl(text)) {
				if (href.startsWith('data:') || href.startsWith('#')) continue;

				const resolved = resolve(encoded, href);
				if (!is_root_relative(resolved)) continue;

				const parsed = new URL(resolved, 'http://localhost');

				if (parsed.search) {
					// TODO warn that query strings have no effect on statically-exported pages
				}

				const pathname = normalize_path(parsed.pathname, config.kit.trailingSlash);
				enqueue(decoded, decodeURI(pathname), pathname);
			}
		}
	}

	/**
	 * @param {Response} response
	 * @param {string | Uint8Array} body
	 * @param {string} decoded
	 * @param {string} encoded
	 * @param {string | null} referrer
	 * @param {'linked' | 'fetched'} referenceType
	 */
	function save(response, body, decoded, encoded, referrer, referenceType) {
		const response_type = Math.floor(response.status / 100);
		const type = /** @type {string} */ (response.headers.get('content-type'));
		const is_html = response_type === REDIRECT || type === 'text/html';

		const file = output_filename(decoded, is_html);
		const dest = `${out}/${file}`;

		if (written.has(file)) return;
		written.add(file);

		if (response_type === REDIRECT) {
			const location = response.headers.get('location');

			if (location) {
				mkdirp(dirname(dest));

				log.warn(`${response.status} ${decoded} -> ${location}`);

				writeFileSync(
					dest,
					`<meta http-equiv="refresh" content=${escape_html_attr(`0;url=${location}`)}>`
				);

				let resolved = resolve(encoded, location);
				if (is_root_relative(resolved)) {
					resolved = normalize_path(resolved, config.kit.trailingSlash);
					enqueue(decoded, decodeURI(resolved), resolved);
				}

				if (!prerendered.redirects.has(decoded)) {
					prerendered.redirects.set(decoded, {
						status: response.status,
						location: resolved
					});

					prerendered.paths.push(normalize_path(decoded, 'never'));
				}
			} else {
				log.warn(`location header missing on redirect received from ${decoded}`);
			}

			return;
		}

		if (response.status === 200) {
			mkdirp(dirname(dest));

			log.info(`${response.status} ${decoded}`);
			writeFileSync(dest, body);

			if (is_html) {
				prerendered.pages.set(decoded, {
					file
				});
			} else {
				prerendered.assets.set(decoded, {
					type
				});
			}

			prerendered.paths.push(normalize_path(decoded, 'never'));
		} else if (response_type !== OK) {
			error({ status: response.status, path: decoded, referrer, referenceType });
		}
	}

	if (config.kit.prerender.enabled) {
		for (const entry of config.kit.prerender.entries) {
			if (entry === '*') {
				for (const entry of build_data.entries) {
					enqueue(null, normalize_path(config.kit.paths.base + entry, config.kit.trailingSlash)); // TODO can we pre-normalize these?
				}
			} else {
				enqueue(null, normalize_path(config.kit.paths.base + entry, config.kit.trailingSlash));
			}
		}

		await q.done();
	}

	if (fallback) {
		const rendered = await app.render(new Request('http://sveltekit-prerender/[fallback]'), {
			prerender: {
				fallback,
				all: false,
				dependencies: new Map()
			}
		});

		const file = join(out, fallback);
		mkdirp(dirname(file));
		writeFileSync(file, await rendered.text());
	}

	return prerendered;
}
