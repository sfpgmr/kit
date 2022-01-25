import { test } from 'uvu';
import * as assert from 'uvu/assert';
import crypto from 'crypto';
import { sha256 } from './crypto.js';

const inputs = ['the quick brown fox jumps over the lazy dog', '工欲善其事，必先利其器'];

inputs.forEach((input) => {
	test(input, () => {
		const expected_bytes = crypto.createHash('sha256').update(input, 'utf-8').digest();
		const expected = expected_bytes.toString('base64');

		assert.equal(sha256(input), expected);
	});
});

test.run();