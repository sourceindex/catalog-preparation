import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { assemble, feedName, Http, listRecord, metadata, prepare } from './prepare.mjs';

const row = { id: 'existing', title: 'Unchanged', url: 'owner/lists/original',
  catalogType: 'traktMovie', traktSortBy: 'random', minYear: 1980, minRating: 57 };
const record = { type: 'movie', tmdbId: 123, imdbId: 'tt123', listTitle: 'Original',
  listYear: 2024, listRating: 8, listCertification: 'PG', listedAt: '2024-01-01' };
const details = { title: 'Original', adult: false, year: 2024, imdbId: 'tt123',
  posterUrl: 'https://image.tmdb.org/t/p/w342/123.jpg', genres: ['Drama'], runtime: 120, mpaa: 'PG' };

test('source identity includes type, not the display name or filters', () => {
  assert.equal(feedName(row), feedName({ ...row, title: 'Renamed', minYear: 1900 }));
  assert.notEqual(feedName(row), feedName({ ...row, url: 'owner/lists/different' }));
  assert.notEqual(feedName(row), feedName({ ...row, catalogType: 'traktTv' }));
});

test('source ordering, duplicates and source filter facts survive preparation', () => {
  const feed = assemble(row.url, [record, record], { 'movie:123': { data: details, at: 12345 } });
  assert.equal(feed.items.length, 2);
  assert.equal(feed.items[0].listYear, 2024);
  assert.equal(feed.items[0].listRating, 8);
  assert.equal(feed.items[0].imdbId, 'tt123');
  assert.equal(feed.items[0].metadataUpdatedAt, 12345);
  assert.throws(() => assemble(row.url, [record], {}), /incomplete/);
});

test('Trakt parser retains real media kinds, dates, and prefilter values', () => {
  assert.deepEqual(listRecord({ type: 'movie', listed_at: record.listedAt,
    movie: { title: 'Original', year: 2024, rating: 8, certification: 'PG', ids: { tmdb: 123, imdb: 'tt123' } } }), record);
  assert.equal(listRecord({ type: 'episode' }), null);
});

test('metadata preserves app image resolution and an English raster logo', () => {
  const result = metadata({ title: 'Original', adult: false, release_date: '2024-01-01',
    poster_path: '/123.jpg', backdrop_path: '/back.jpg',
    images: { logos: [{ file_path: '/bad.svg', iso_639_1: 'en' }, { file_path: '/good.png', iso_639_1: 'en' }] },
    release_dates: { results: [{ iso_3166_1: 'US', release_dates: [{ certification: '' }, { certification: 'PG' }] }] },
  }, 'movie');
  assert.equal(result.backdropUrl, 'https://image.tmdb.org/t/p/w1280/back.jpg');
  assert.equal(result.clearLogoUrl, 'https://image.tmdb.org/t/p/w500/good.png');
  assert.equal(result.mpaa, 'PG');
});

test('Trakt pagination uses explicit request headers and retains all pages', async () => {
  const calls = [];
  const http = new Http({ trakt: 'test' }, async (uri, options) => {
    calls.push({ uri: new URL(uri), headers: options.headers });
    return new Response(JSON.stringify([{ type: 'movie', movie: { title: 'Original', ids: { tmdb: calls.length } } }]),
      { headers: { 'x-pagination-page-count': '2', 'x-pagination-limit': '1' } });
  });
  const records = await http.list(row);
  assert.deepEqual(records.map(entry => entry.tmdbId), [1, 2]);
  assert.equal(calls[0].headers['trakt-api-key'], 'test');
  assert.equal(calls[0].headers['Content-Type'], 'application/json');
  assert.ok(calls[0].headers['User-Agent']);
});

test('MDBList uses its public feed and preserves media and adult filtering', async () => {
  let called;
  const http = new Http({}, async (uri, options) => {
    called = { uri: new URL(uri), headers: options.headers };
    return new Response(JSON.stringify([
      { id: 123, mediatype: 'show', title: 'Original', release_year: 2024, imdb_id: 'tt123' },
      { id: 456, mediatype: 'movie', title: 'Wrong kind' },
      { id: 789, mediatype: 'show', title: 'Adult', adult: true },
    ]));
  });
  const items = await http.list({ catalogType: 'traktTv',
    url: 'https://mdblist.com/lists/official/shows/trending?sort=movie_list' });
  assert.equal(called.uri.href, 'https://mdblist.com/lists/official/shows/trending/json');
  assert.equal(called.headers.Authorization, undefined);
  assert.deepEqual(items.map(item => item.tmdbId), [123]);
});

test('mixed MDBList feeds preserve movie/show identity and reject adult entries', async () => {
  const http = new Http({}, async () => new Response(JSON.stringify([
    { id: 123, mediatype: 'movie' }, { id: 123, mediatype: 'show' },
    { id: 456, mediatype: 'movie', adult: 1 }, { id: 789, mediatype: 'episode' },
  ])));
  const items = await http.list({ catalogType: 'traktMixed', url: 'https://mdblist.com/lists/test/family' });
  assert.deepEqual(items.map(item => `${item.type}:${item.tmdbId}`), ['movie:123', 'show:123']);
});

test('kids preparation preserves approved content and leaves legacy catalogs intact', async t => {
  const root = await mkdtemp(join(tmpdir(), 'upnext-kids-'));
  assert.equal(dirname(resolve(root)), resolve(tmpdir()));
  assert.ok(root.split(/[\\/]/).pop().startsWith('upnext-kids-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'genres'));
  await mkdir(join(root, 'kids'));
  for (const file of ['home.json', 'movie.json', 'tv.json', 'home-kids.json']) {
    await writeFile(join(root, file), JSON.stringify([row]));
  }
  const kids = { ...row, id: 'family', title: 'Approved title', catalogType: 'traktMixed',
    url: 'https://mdblist.com/lists/test/family' };
  for (const file of ['home-kids.json', 'movie-kids.json', 'tv-kids.json']) {
    await writeFile(join(root, 'kids', file), JSON.stringify([kids]));
  }
  const calls = [];
  const status = await prepare({ root, cachePath: join(root, '.cache', 'metadata.json'),
    base: 'https://example.com', activate: true, onlyFiles: ['kids/home-kids.json'],
    http: { list: async source => { calls.push(source.url); return [record, { ...record, type: 'show' }]; },
      details: async () => details } });
  assert.equal(status.ready, 1);
  assert.deepEqual(calls, [kids.url]);
  assert.deepEqual(JSON.parse(await readFile(join(root, 'home-kids.json'), 'utf8')), [row]);
  const actual = JSON.parse(await readFile(join(root, 'kids', 'home-kids.json'), 'utf8'));
  assert.ok(actual[0].preparedUrl.endsWith(feedName(kids)));
  delete actual[0].preparedUrl;
  assert.deepEqual(actual, [kids]);
  const feed = JSON.parse(await readFile(join(root, 'prepared', 'lists', feedName(kids)), 'utf8'));
  assert.deepEqual(feed.items.map(item => item.type), ['movie', 'show']);
});

test('publishing adds only preparedUrl; incomplete refresh retains last complete feed', async t => {
  const root = await mkdtemp(join(tmpdir(), 'upnext-prepared-'));
  assert.equal(dirname(resolve(root)), resolve(tmpdir()));
  assert.ok(root.split(/[\\/]/).pop().startsWith('upnext-prepared-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'genres'));
  const original = [row, { id: 'continue_watching', catalogType: 'continueWatching', title: 'Continue Watching', url: null }];
  for (const file of ['home.json', 'movie.json', 'tv.json', 'home-kids.json']) {
    await writeFile(join(root, file), JSON.stringify(original));
  }
  await writeFile(join(root, 'genres', 'crime.json'), JSON.stringify(original));
  const cachePath = join(root, '.cache', 'metadata.json');
  let requests = 0;
  const http = { list: async () => [record], details: async () => { requests++; return details; } };
  const options = { root, cachePath, http, base: 'https://example.com', activate: true };
  const status = await prepare(options);
  assert.equal(status.ready, 1);
  assert.equal(requests, 1);
  for (const file of ['home.json', 'movie.json', 'tv.json', 'home-kids.json', 'genres/crime.json']) {
    const actual = JSON.parse(await readFile(join(root, file), 'utf8'));
    assert.equal(actual[0].preparedUrl, `https://example.com/prepared/lists/${feedName(row)}`);
    delete actual[0].preparedUrl;
    assert.deepEqual(actual, original);
  }
  const path = join(root, 'prepared', 'lists', feedName(row));
  await writeFile(cachePath, '{}');
  const seeded = await prepare({ ...options, maxDetails: 0 });
  assert.equal(seeded.ready, 1);
  assert.equal(requests, 1);
  const before = await readFile(path, 'utf8');
  http.list = async () => [record, { ...record, tmdbId: 456 }];
  const deferred = await prepare({ ...options, maxDetails: 0 });
  assert.equal(deferred.deferred, 1);
  assert.equal(await readFile(path, 'utf8'), before);
  assert.equal(requests, 1);
});
