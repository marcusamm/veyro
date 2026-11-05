import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { analyticsReport, analyticsSessionDetail, analyticsSource, purgeSiteAnalytics, recordAnalyticsEvent, ANALYTICS_RETENTION_SECONDS } from '../src/lib/site-analytics';
import { midnight, parsePeriod } from '../src/lib/stats';

let sqlite, db;
// Exercise real SQLite statements/constraints/transactions using the D1 method contract.
function databaseAdapter(sqlite) {
  const statement = (sql, values = []) => ({
    bind: (...args) => statement(sql, args),
    first: async () => sqlite.prepare(sql).get(...values) ?? null,
    all: async () => ({ results: sqlite.prepare(sql).all(...values), success: true }),
    run: async () => { const r = sqlite.prepare(sql).run(...values); return { success: true, meta: { changes: r.changes } }; },
    execute: () => {
      const s = sqlite.prepare(sql);
      if (s.columns().length) return { success: true, results: s.all(...values), meta: { changes: 0 } };
      const r = s.run(...values);
      return { success: true, results: [], meta: { changes: r.changes } };
    },
  });
  return {
    prepare: sql => statement(sql),
    batch: async statements => {
      sqlite.exec('BEGIN IMMEDIATE');
      try { const results = statements.map(s => s.execute()); sqlite.exec('COMMIT'); return results; }
      catch (e) { sqlite.exec('ROLLBACK'); throw e; }
    },
  };
}
const uuid = () => crypto.randomUUID();
const page = (path = '/', eventId = uuid()) => ({ type: 'pageview', eventId, path });
const context = { country: 'DK', region: 'Zealand', city: 'Slagelse', device: 'desktop', browser: 'Chrome', os: 'macOS' };
const cookies = receipt => ({ visitorId: receipt.visitorId, sessionId: receipt.sessionId });
const count = table => sqlite.prepare(`SELECT count(*) AS n FROM ${table}`).get().n;
const now = midnight('2026-11-05') + 12 * 3600;

beforeEach(() => {
  sqlite = new DatabaseSync(':memory:');
  sqlite.exec('PRAGMA foreign_keys=ON');
  sqlite.exec('CREATE TABLE site_views(day TEXT, path TEXT, views INTEGER)');
  sqlite.exec(readFileSync(new URL('../migrations/0017_site_analytics.sql', import.meta.url), 'utf8'));
  db = databaseAdapter(sqlite);
});
afterEach(() => sqlite.close());

describe('Consent analytics persistence and reports', () => {
  it('deduplicates a page event, including simultaneous first-event delivery, without orphan records', async () => {
    const event = page();
    const [a,b] = await Promise.all([recordAnalyticsEvent(db,event,context,now),recordAnalyticsEvent(db,event,context,now)]);
    const accepted = [a,b].find(r => r.accepted);
    expect(accepted).toBeTruthy();
    expect(count('site_analytics_visitors')).toBe(1);
    expect(count('site_analytics_sessions')).toBe(1);
    expect(count('site_analytics_pageviews')).toBe(1);
    expect((await analyticsSessionDetail(db,accepted.sessionId)).session.pageviews).toBe(1);
    expect((await recordAnalyticsEvent(db,event,{...context,...cookies(accepted)},now+60)).accepted).toBe(true);
    expect((await analyticsSessionDetail(db,accepted.sessionId)).session.lastSeenAt).toBe(now);
    expect((await recordAnalyticsEvent(db,event,{...context,...cookies(accepted)},now+1800)).accepted).toBe(false);
    expect(count('site_analytics_sessions')).toBe(1);
  });

  it('keeps page journeys together then starts a returning visit after thirty idle minutes', async () => {
    const first = await recordAnalyticsEvent(db,page('/'),context,now);
    const second = await recordAnalyticsEvent(db,page('/pages/hosting'),{...context,...cookies(first)},now+45);
    expect(second.sessionId).toBe(first.sessionId);
    const next = await recordAnalyticsEvent(db,page('/pages/kontakt'),{...context,...cookies(first)},now+45+1800);
    expect(next.sessionId).not.toBe(first.sessionId);
    expect(next.visitorId).toBe(first.visitorId);
    const old = await analyticsSessionDetail(db,first.sessionId);
    expect(old.session).toMatchObject({ returning: false, pageviews: 2, entryPath: '/', exitPath: '/pages/hosting' });
    expect(old.pages.map(p => p.path)).toEqual(['/','/pages/hosting']);
    expect((await analyticsSessionDetail(db,next.sessionId)).session.returning).toBe(true);
  });

  it('reuses one new session for simultaneous page loads from a returning browser', async () => {
    const first = await recordAnalyticsEvent(db,page(),context,now);
    const identity = { ...context, visitorId: first.visitorId };
    const [a,b] = await Promise.all([
      recordAnalyticsEvent(db,page('/pages/hosting'),identity,now+1800),
      recordAnalyticsEvent(db,page('/pages/kontakt'),identity,now+1800),
    ]);
    expect(a.accepted && b.accepted).toBe(true);
    expect(a.sessionId).toBe(b.sessionId);
    expect(a.sessionId).not.toBe(first.sessionId);
    expect(count('site_analytics_sessions')).toBe(2);
    const detail = await analyticsSessionDetail(db,a.sessionId);
    expect(detail.session).toMatchObject({ returning: true, pageviews: 2 });
    expect(detail.pages).toHaveLength(2);
  });

  it('bounds cumulative engagement to elapsed time and applies replays or out-of-order updates once', async () => {
    const event = page('/pages/hosting');
    const first = await recordAnalyticsEvent(db,event,context,now);
    const identity = {...context,...cookies(first)};
    for (const [offset,activeSeconds,scrollDepth] of [[20,9999,150],[25,10,25],[30,20,50],[45,40,75]]) {
      await recordAnalyticsEvent(db,{...event,type:'engagement',activeSeconds,scrollDepth},identity,now+offset);
    }
    const detail = await analyticsSessionDetail(db,first.sessionId);
    expect(detail.pages[0]).toMatchObject({activeSeconds:40,scrollDepth:100});
    expect(detail.session.activeSeconds).toBe(40);
    expect(detail.session.pageviews).toBe(1);
    expect((await recordAnalyticsEvent(db,{...event,type:'engagement',activeSeconds:60},identity,now+45+1800)).accepted).toBe(false);
    expect(count('site_analytics_sessions')).toBe(1);
  });

  it('rejects unowned, unknown and private-page engagement without creating identities', async () => {
    expect((await recordAnalyticsEvent(db,{...page(),type:'engagement'},context,now)).accepted).toBe(false);
    expect((await recordAnalyticsEvent(db,page('/admin/kunder/2'),context,now)).accepted).toBe(false);
    expect((await recordAnalyticsEvent(db,page('/cart'),context,now)).accepted).toBe(false);
    expect((await recordAnalyticsEvent(db,page('/pages/hosting?email=a@example.com'),context,now)).accepted).toBe(false);
    expect((await recordAnalyticsEvent(db,page('/pages/hosting#person'),context,now)).accepted).toBe(false);
    expect(count('site_analytics_visitors')).toBe(0);
    const event=page(); const first=await recordAnalyticsEvent(db,event,context,now);
    expect((await recordAnalyticsEvent(db,{...event,type:'engagement',activeSeconds:10},{visitorId:uuid(),sessionId:first.sessionId},now+15)).accepted).toBe(false);
    expect((await recordAnalyticsEvent(db,{...event,type:'engagement',activeSeconds:10},{visitorId:first.visitorId,sessionId:uuid()},now+15)).accepted).toBe(false);
  });

  it('reports Danish start dates, distinct browsers, genuine return visits and historical aggregates separately', async () => {
    const t=midnight('2026-11-05')+30; // Still November 4 in UTC.
    const first=await recordAnalyticsEvent(db,{...page(),referrer:'https://www.google.com/search?q=private+search'},context,t);
    await recordAnalyticsEvent(db,page('/pages/hosting'),{...context,...cookies(first)},t+20);
    await recordAnalyticsEvent(db,page('/'),{...context,...cookies(first)},t+1820);
    await recordAnalyticsEvent(db,{...page('/en/'),campaignSource:'instagram'},{country:'GB',city:'London',device:'mobile',browser:'Safari',os:'iOS'},t+10);
    sqlite.prepare('INSERT INTO site_views VALUES (?, ?, ?)').run('2026-11-05','/',12);
    const report=await analyticsReport(db,parsePeriod('2026-11',now));
    expect(report.totals).toMatchObject({visits:3,uniqueVisitors:2,returningVisits:1,pageviews:4,pagesPerVisit:4/3,returningRate:1/3});
    expect(report.daily.find(d=>d.day==='2026-11-05')).toMatchObject({visits:3,uniqueVisitors:2,pageviews:4});
    expect(report.countries).toEqual([{label:'DK',visits:2},{label:'GB',visits:1}]);
    expect(report.cities).toContainEqual({label:'Slagelse, DK',visits:2});
    expect(report.sources).toContainEqual({label:'www.google.com',visits:1});
    expect(report.sources).toContainEqual({label:'instagram (kampagne)',visits:1});
    expect(report.allPageviews).toBe(12);
    expect(report.firstRecordedAt).toBe(t);
    expect(JSON.stringify(report)).not.toContain('private+search');
  });

  it('expires old journeys and their otherwise-unused visitor identifiers after ninety days', async () => {
    const old=await recordAnalyticsEvent(db,page(),context,now-ANALYTICS_RETENTION_SECONDS-10);
    const current=await recordAnalyticsEvent(db,page(),context,now);
    await purgeSiteAnalytics(db,now);
    expect(await analyticsSessionDetail(db,old.sessionId)).toBeNull();
    expect(await analyticsSessionDetail(db,current.sessionId)).toBeTruthy();
    expect(count('site_analytics_visitors')).toBe(1);
    expect(count('site_analytics_pageviews')).toBe(1);
    const empty=await analyticsReport(db,parsePeriod('2020-01',now));
    expect(empty.totals).toMatchObject({visits:0,uniqueVisitors:0,averageActiveSeconds:0,pagesPerVisit:0,returningRate:0});
  });

  it('keeps Danish midnight and daily reports correct on both daylight-saving transition dates', async () => {
    expect(new Date(midnight('2026-03-29') * 1000).toISOString()).toBe('2026-03-28T23:00:00.000Z');
    expect(new Date(midnight('2026-03-30') * 1000).toISOString()).toBe('2026-03-29T22:00:00.000Z');
    expect(new Date(midnight('2026-10-25') * 1000).toISOString()).toBe('2026-10-24T22:00:00.000Z');
    expect(new Date(midnight('2026-10-26') * 1000).toISOString()).toBe('2026-10-25T23:00:00.000Z');
    for (const day of ['2026-03-29', '2026-10-25']) {
      const boundary = midnight(day);
      await recordAnalyticsEvent(db,page(),context,boundary-1);
      await recordAnalyticsEvent(db,page(),context,boundary);
      const report = await analyticsReport(db,parsePeriod(day.slice(0,7),now));
      expect(report.daily.find(d=>d.day===day)?.visits).toBe(1);
    }
  });

  it('retains only coarse safe source information', () => {
    expect(analyticsSource('https://example.com/path?email=a@example.com#details')).toBe('example.com');
    expect(analyticsSource('https://veyro.dk/pages/priser')).toBe('Direkte / ukendt');
    expect(analyticsSource('https://other.example','email')).toBe('email (kampagne)');
    expect(analyticsSource(undefined,'person@example.com')).toBe('Direkte / ukendt');
    expect(analyticsSource('javascript:alert(1)')).toBe('Direkte / ukendt');
    expect(analyticsSource('http://192.168.2.33:8080/private')).toBe('Direkte / ukendt');
    expect(analyticsSource('https://[2001:db8::1]/')).toBe('Direkte / ukendt');
  });
});
