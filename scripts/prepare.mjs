import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const sleep = ms => new Promise(done => setTimeout(done, ms));
const image = (path, size) => path ? `https://image.tmdb.org/t/p/${size}${path}` : null;
const week = 7 * 86400000;
const metadataKeys = ['title', 'adult', 'imdbId', 'year', 'overview', 'posterUrl',
  'backdropUrl', 'clearLogoUrl', 'genres', 'runtime', 'seasons', 'mpaa'];

export function feedName(row) {
  return createHash('sha256').update(`${row.catalogType}:${row.url}`).digest('hex').slice(0, 24) + '.json';
}

export async function catalogs(root) {
  const files = ['home.json', 'movie.json', 'tv.json', 'home-kids.json'];
  for (const file of ['kids/home-kids.json', 'kids/movie-kids.json', 'kids/tv-kids.json']) {
    if (await readJson(join(root, file), null) !== null) files.push(file);
  }
  for (const name of await readdir(join(root, 'genres'))) {
    if (name.endsWith('.json')) files.push(`genres/${name}`);
  }
  const result = [];
  for (const file of files) {
    const rows = JSON.parse(await readFile(join(root, file), 'utf8'));
    if (!Array.isArray(rows)) throw new Error(`Not a catalog array: ${file}`);
    result.push({ file, rows });
  }
  return result;
}

export function listRecord(raw) {
  const type = raw.type;
  if (type !== 'movie' && type !== 'show') return null;
  const inner = raw[type] ?? {};
  return {
    type, tmdbId: inner.ids?.tmdb ?? null, imdbId: inner.ids?.imdb ?? null,
    listTitle: inner.title ?? '', listYear: inner.year ?? null,
    listRating: inner.rating ?? null, listCertification: inner.certification ?? null,
    listedAt: raw.listed_at ?? null,
  };
}

export function metadata(raw, type) {
  const tv = type === 'show';
  const ratings = tv ? raw.content_ratings?.results : raw.release_dates?.results;
  const us = ratings?.find(entry => entry.iso_3166_1 === 'US');
  const logos = (raw.images?.logos ?? []).filter(entry => /\.(png|webp|jpe?g)$/i.test(entry.file_path ?? ''));
  const logo = logos.find(entry => entry.iso_639_1 === 'en') ?? logos[0];
  return {
    title: raw.title ?? raw.name ?? '', adult: raw.adult,
    imdbId: raw.external_ids?.imdb_id ?? raw.imdb_id ?? null,
    year: Number((raw.release_date ?? raw.first_air_date ?? '').slice(0, 4)) || null,
    overview: raw.overview ?? null,
    posterUrl: image(raw.poster_path, 'w342'), backdropUrl: image(raw.backdrop_path, 'w1280'),
    clearLogoUrl: image(logo?.file_path, 'w500'),
    genres: (raw.genres ?? []).map(entry => entry.name),
    runtime: tv ? raw.episode_run_time?.[0] ?? null : raw.runtime ?? null,
    seasons: tv ? raw.number_of_seasons ?? null : null,
    mpaa: tv ? us?.rating ?? null : us?.release_dates?.find(entry => entry.certification)?.certification ?? null,
  };
}

export function assemble(source, records, cache, now = Date.now()) {
  const items = records.map(record => {
    const entry = cache[`${record.type}:${record.tmdbId}`];
    if (record.tmdbId && !entry) throw new Error('Metadata preparation incomplete');
    return {
      ...record,
      ...(entry?.data ?? { title: record.listTitle, unavailable: true }),
      imdbId: entry?.data?.imdbId ?? record.imdbId,
      metadataUpdatedAt: entry?.at ?? null,
    };
  });
  return { version: 1, source, language: 'en', generatedAt: new Date(now).toISOString(), items };
}

async function writeJson(path, data, pretty = false) {
  await mkdir(dirname(path), { recursive: true });
  const bytes = JSON.stringify(data, null, pretty ? 2 : undefined) + '\n';
  await writeFile(path + '.tmp', bytes);
  await rename(path + '.tmp', path);
  return Buffer.byteLength(bytes);
}

async function readJson(path, fallback) {
  try { return JSON.parse(await readFile(path, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return fallback; throw error; }
}

export class Http {
  constructor(keys, request = fetch) {
    this.keys = keys;
    this.request = request;
    this.starts = new Map();
  }

  async get(url, headers = {}) {
    const host = new URL(url).hostname;
    const interval = host === 'api.themoviedb.org' ? 70 : host === 'api.trakt.tv' ? 500 : 2000;
    for (let attempt = 0; attempt < 4; attempt++) {
      // Reserve starts synchronously so concurrent workers share one limiter.
      const start = Math.max(Date.now(), this.starts.get(host) ?? 0);
      this.starts.set(host, start + interval);
      await sleep(Math.max(0, start - Date.now()));
      let response;
      try {
        response = await this.request(url, { headers: { 'User-Agent': 'UpNext-Catalog-Publisher',
          'Content-Type': 'application/json', ...headers }, signal: AbortSignal.timeout(35000) });
      } catch {
        if (attempt === 3) throw new Error(`${host}: transport failure`);
        await sleep(1000 * (attempt + 1));
        continue;
      }
      if (response.status === 404) return { data: null, headers: response.headers };
      if (response.status === 429 || response.status >= 500) {
        await response.body?.cancel();
        if (attempt === 3) throw new Error(`${host}: HTTP ${response.status}`);
        const retry = response.headers.get('retry-after');
        const delay = /^\d+$/.test(retry ?? '') ? Number(retry) * 1000 : 2000 * (attempt + 1);
        this.starts.set(host, Math.max(this.starts.get(host) ?? 0, Date.now() + delay));
        await sleep(delay);
        continue;
      }
      if (!response.ok) throw new Error(`${host}: HTTP ${response.status}`);
      const data = await response.json();
      return { data, headers: response.headers };
    }
    throw new Error(`${host}: retries exhausted`);
  }

  async list(row) {
    if (row.url.startsWith('https://mdblist.com/')) {
      const uri = new URL(row.url);
      uri.search = '';
      uri.pathname = uri.pathname.replace(/\/$/, '') + '/json';
      const { data } = await this.get(uri);
      if (!Array.isArray(data)) throw new Error('Invalid MDBList feed');
      const type = row.catalogType === 'traktMixed' ? null : row.catalogType === 'traktTv' ? 'show' : 'movie';
      return data.filter(entry => (entry.mediatype === 'movie' || entry.mediatype === 'show') &&
          (type === null || entry.mediatype === type) && entry.adult !== true && entry.adult !== 1)
        .filter(entry => Number.isInteger(Number(entry.id)) && Number(entry.id) > 0)
        .map(entry => ({ type: entry.mediatype, tmdbId: Number(entry.id), imdbId: entry.imdb_id ?? null,
          listTitle: entry.title ?? '', listYear: Number(entry.release_year) || null,
          listRating: null, listCertification: null, listedAt: null }));
    }
    if (!/^[^/]+\/lists\/[^/]+$/.test(row.url)) throw new Error('Unsupported source URL');
    const records = [];
    for (let page = 1; ; page++) {
      const uri = new URL(`https://api.trakt.tv/users/${row.url}/items`);
      uri.search = new URLSearchParams({ extended: 'full', page: String(page), limit: '250' });
      const headers = { 'trakt-api-version': '2', 'trakt-api-key': this.keys.trakt };
      let { data, headers: pagination } = await this.get(uri, headers);
      if (!Array.isArray(data)) throw new Error('Invalid Trakt feed');
      if (!data.length && pagination.get('x-pagination-item-count') !== '0' && page === 1) {
        uri.searchParams.set('_', String(Date.now()));
        ({ data, headers: pagination } = await this.get(uri, headers));
        if (!Array.isArray(data) || (!data.length && pagination.get('x-pagination-item-count') !== '0')) {
          throw new Error('Unexpected empty Trakt feed');
        }
      }
      records.push(...data.map(listRecord).filter(Boolean));
      const pages = Number(pagination.get('x-pagination-page-count'));
      const limit = Number(pagination.get('x-pagination-limit')) || 250;
      if ((pages && page >= pages) || (!pages && data.length < limit)) break;
      if (!data.length || page >= 1000) throw new Error('Incomplete Trakt pagination');
    }
    return records;
  }

  async details(record) {
    const tv = record.type === 'show';
    const uri = new URL(`https://api.themoviedb.org/3/${tv ? 'tv' : 'movie'}/${record.tmdbId}`);
    uri.search = new URLSearchParams({ api_key: this.keys.tmdb, language: 'en',
      append_to_response: `external_ids,images,${tv ? 'content_ratings' : 'release_dates'}` });
    const { data } = await this.get(uri);
    if (data === null) return null;
    if (data.id !== record.tmdbId || typeof data.adult !== 'boolean') throw new Error('Invalid TMDB details');
    return metadata(data, record.type);
  }
}

export async function prepare({ root, cachePath, base, activate = false, maxDetails = Infinity, onlyFiles,
  http = new Http({ tmdb: process.env.TMDB_API_KEY, trakt: process.env.TRAKT_CLIENT_ID }) }) {
  const configs = await catalogs(root);
  const cache = await readJson(cachePath, {});
  // Existing published feeds can seed a new runner; the application never
  // downloads this publisher-side cache or keeps a full catalog on disk.
  const folder = join(root, 'prepared', 'lists');
  for (const name of await readdir(folder).catch(error => error.code === 'ENOENT' ? [] : Promise.reject(error))) {
    if (!/^[0-9a-f]{24}\.json$/.test(name)) continue;
    const feed = await readJson(join(folder, name), null);
    if (feed?.version !== 1) continue;
    for (const item of feed.items) {
      const key = `${item.type}:${item.tmdbId}`;
      if (!item.tmdbId || cache[key]) continue;
      cache[key] = { at: item.metadataUpdatedAt ?? Date.parse(feed.generatedAt), data: item.unavailable ? null :
        Object.fromEntries(metadataKeys.map(field => [field, item[field] ?? null])) };
    }
  }
  const sources = new Map();
  for (const config of configs) {
    if (onlyFiles && !onlyFiles.includes(config.file)) continue;
    for (const row of config.rows) {
      if (['traktMovie', 'traktTv', 'traktMixed'].includes(row.catalogType) && row.url) sources.set(feedName(row), row);
    }
  }
  const status = { generatedAt: new Date().toISOString(), sources: sources.size,
    ready: 0, deferred: 0, failed: [], detailRequests: 0 };
  const ready = new Set();
  try {
    for (const [name, row] of sources) {
      try {
        const records = await http.list(row);
        const pending = new Map();
        for (const record of records) {
          const key = `${record.type}:${record.tmdbId}`;
          const entry = cache[key];
          if (record.tmdbId && (!entry || Date.now() - entry.at > week)) pending.set(key, record);
        }
        const jobs = [...pending.entries()];
        let index = 0;
        await Promise.all(Array.from({ length: Math.min(6, jobs.length) }, async () => {
          while (index < jobs.length && status.detailRequests < maxDetails) {
            const [key, record] = jobs[index++];
            const request = ++status.detailRequests;
            try { cache[key] = { at: Date.now(), data: await http.details(record) }; }
            catch { /* Keep an older complete record; new misses defer this feed. */ }
            if (request % 200 === 0) {
              console.log(`Metadata ${status.detailRequests}; preparing ${row.id}`);
            }
          }
        }));
        if (records.some(record => record.tmdbId && !cache[`${record.type}:${record.tmdbId}`])) {
          status.deferred++;
          if (status.detailRequests >= maxDetails) break;
          continue;
        }
        const feed = assemble(row.url, records, cache);
        const bytes = Buffer.byteLength(JSON.stringify(feed)) + 1;
        if (bytes > 8 * 1024 * 1024 || feed.items.length > 20000) throw new Error('Feed exceeds client safety limit');
        await writeJson(join(root, 'prepared', 'lists', name), feed);
        ready.add(name);
        status.ready++;
      } catch (error) {
        status.failed.push({ source: row.url, error: error.message });
        console.log(`Source ${row.id}: ${error.message}`);
      } finally {
        await writeJson(cachePath, cache);
        console.log(`Feeds ready=${status.ready} deferred=${status.deferred} failed=${status.failed.length} / ${status.sources}; details=${status.detailRequests}`);
      }
    }
    status.deferred = status.sources - status.ready - status.failed.length;
    if (activate) {
      for (const config of configs) {
        let changed = false;
        for (const row of config.rows) {
          const name = feedName(row);
          if (!ready.has(name)) continue;
          const url = `${base.replace(/\/$/, '')}/prepared/lists/${name}`;
          if (row.preparedUrl !== url) { row.preparedUrl = url; changed = true; }
        }
        if (changed) await writeJson(join(root, config.file), config.rows, true);
      }
      const active = new Set(configs.flatMap(config => config.rows)
        .filter(row => row.preparedUrl).map(row => new URL(row.preparedUrl).pathname.split('/').pop()));
      const folder = join(root, 'prepared', 'lists');
      for (const name of await readdir(folder).catch(error => error.code === 'ENOENT' ? [] : Promise.reject(error))) {
        if (/^[0-9a-f]{24}\.json$/.test(name) && !active.has(name)) await unlink(join(folder, name));
      }
    }
    await writeJson(join(root, 'prepared', 'status.json'), status, true);
    return status;
  } finally {
    await writeJson(cachePath, cache);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const args = process.argv.slice(2);
  const option = (name, fallback) => args.includes(name) ? args[args.indexOf(name) + 1] : fallback;
  const root = resolve(option('--root', '.'));
  if (!process.env.TMDB_API_KEY || !process.env.TRAKT_CLIENT_ID) throw new Error('TMDB_API_KEY and TRAKT_CLIENT_ID are required');
  const result = await prepare({ root, cachePath: resolve(option('--cache', join(root, '.cache', 'metadata.json'))),
    base: option('--base', 'https://raw.githubusercontent.com/sourceindex/view-index/main'),
    activate: args.includes('--activate'), maxDetails: Number(option('--max-details', 'Infinity')),
    onlyFiles: option('--only', null)?.split(',') });
  console.log(JSON.stringify(result));
}
