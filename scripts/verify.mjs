import assert from 'node:assert/strict';
import { readFile, stat } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { catalogs, feedName } from './prepare.mjs';

const root = resolve(process.argv[2]);
let rows = 0;
const seen = new Set();
for (const { rows: entries } of await catalogs(root)) {
  for (const row of entries) {
    if (!['traktMovie', 'traktTv', 'traktMixed'].includes(row.catalogType) || !row.url) continue;
    rows++;
    const name = feedName(row);
    assert.equal(row.preparedUrl,
      `https://raw.githubusercontent.com/sourceindex/view-index/main/prepared/lists/${name}`);
    if (seen.has(name)) continue;
    seen.add(name);
    const path = join(root, 'prepared', 'lists', name);
    assert.ok((await stat(path)).size <= 8 * 1024 * 1024);
    const feed = JSON.parse(await readFile(path, 'utf8'));
    assert.equal(feed.source, row.url);
    assert.equal(feed.version, 1);
    assert.equal(feed.language, 'en');
    assert.ok(Array.isArray(feed.items) && feed.items.length <= 20000);
    for (const item of feed.items) {
      assert.equal(typeof item.title, 'string');
      if (!item.unavailable) assert.equal(typeof item.adult, 'boolean');
    }
  }
}
console.log(JSON.stringify({ validatedRows: rows, validatedFeeds: seen.size }));
