import { webcrypto } from 'crypto';

// exported for dev/preview and node environments
export function polyfill_crypto() {
	Object.defineProperties(globalThis, {
		crypto: {
			enumerable: true,
			configurable: true,
			value: webcrypto
		}
	});
}
