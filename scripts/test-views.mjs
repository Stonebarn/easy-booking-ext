// View-model tests for hubspot-data.js. No npm deps: the data module is a
// plain script that hangs itself off `self`, so it is loaded into a vm
// sandbox with a minimal `self` shim. Run: node scripts/test-views.mjs
// Pin the zone before any Date is built: the fixtures use a fixed instant and
// the overdue rule is local-date based, so the suite must not depend on the
// machine's zone (the workflow runs in UTC, Jack's laptop in Eastern).
process.env.TZ = "America/New_York";

import fs from "node:fs";
import vm from "node:vm";
import assert from "node:assert";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const sandbox = { console: { ...console, debug() {} }, fetch: async () => { throw new Error("no net"); }, chrome: { storage: { local: { get: async () => ({}), set: async () => {} } }, runtime: {} }, URL, Intl, Date, setTimeout, clearTimeout };
sandbox.self = sandbox;
vm.createContext(sandbox);
// gtm-tech.js first, the same order sidepanel.html loads them in.
vm.runInContext(fs.readFileSync(ROOT + "gtm-tech.js", "utf8"), sandbox, { filename: "gtm-tech.js" });
vm.runInContext(fs.readFileSync(ROOT + "hubspot-data.js", "utf8"), sandbox, { filename: "hubspot-data.js" });
const D = sandbox.EB.hubspotData;
let n = 0;
const eq = (a, b, m) => { assert.deepStrictEqual(JSON.parse(JSON.stringify(a)), b, m); n++; };
const ok = (v, m) => { assert.ok(v, m); n++; };
const DAY = 86400000;
const NOW = Date.UTC(2026, 9, 21, 15, 0, 0);
const co = (props) => ({ id: "1", properties: props });
const ctxOf = (props) => D.view.accountContext(co(props), { now: NOW });

eq(D.CONFIG.CACHE_VERSION, 16, "cache version");
eq(D.CONFIG.ACCOUNT_OWNER_LOOKUP_MAX, 25, "owner lookup max");
for (const p of ["inbound_source", "inbound_source_last_updated"]) ok(D.CONFIG.CONTACT_PROPERTIES.includes(p), "contact prop " + p);
for (const p of ["inbound_source","inbound_source_last_updated","last_bulk_contact_enrichment_date","company_source","communications_channel_company","ae_contacts","amcs_contacts","gtm_ops_contacts","sales_leader_contacts","sdr_contacts","number_of_associated_sales_team_contacts","wiza_credit_depletion_days_company","api_credit_balance_company","api_credits_used__30_days_cloned","credit_use_per_day_company","number_of_credits_used_in_last_30_days","number_of_active_users_last_30_days","next_checkin","company_research","competitor_tech","missing_wiza_features","wiza_account_create_date"]) ok(D.CONFIG.COMPANY_PROPERTIES.includes(p), "company prop " + p);
ok(new Set(D.CONFIG.COMPANY_PROPERTIES).size === D.CONFIG.COMPANY_PROPERTIES.length, "no dup company props");
ok(new Set(D.CONFIG.CONTACT_PROPERTIES).size === D.CONFIG.CONTACT_PROPERTIES.length, "no dup contact props");

// A. account type precedence
let t = ctxOf({ inbound_source: "PLG Signup", inbound_source_last_updated: String(NOW - 12 * DAY), last_bulk_contact_enrichment_date: String(NOW - 3 * DAY) }).accountType;
eq(t, { kind: "inbound", label: "Inbound · PLG Signup", detail: "12d ago", source: "PLG Signup", at: NOW - 12 * DAY }, "inbound beats prospected");
t = ctxOf({ inbound_source: "Website Visit" }).accountType;
eq([t.kind, t.label, t.detail, t.at], ["inbound", "Inbound · Website Visit", null, null], "inbound with no date");
t = ctxOf({ last_bulk_contact_enrichment_date: new Date(NOW - 12 * DAY).toISOString() }).accountType;
eq(t, { kind: "prospected", label: "Prospected", detail: "enriched 12d ago", source: null, at: NOW - 12 * DAY }, "prospected");
let c = ctxOf({});
eq(c.accountType, { kind: "unknown", label: "Unknown", detail: null, source: null, at: null }, "unknown");
eq(c.hasData, false, "unknown alone is not data");
eq(ctxOf({ inbound_source: "Denied Booking" }).hasData, true, "inbound counts as data");
eq(ctxOf({ last_bulk_contact_enrichment_date: "2026-10-01" }).hasData, true, "prospected counts as data");
eq(ctxOf({ inbound_source: "  ", last_bulk_contact_enrichment_date: "" }).accountType.kind, "unknown", "blank strings are unknown");

// D. team mix
eq(ctxOf({}).teamMix, null, "no mix");
eq(ctxOf({ sdr_contacts: "0", ae_contacts: "" }).teamMix, null, "all zero/blank -> null");
c = ctxOf({ sdr_contacts: "4", ae_contacts: "12", amcs_contacts: "", sales_leader_contacts: "2", number_of_associated_sales_team_contacts: "22" });
eq(c.teamMix, { sdr: 4, ae: 12, amcs: null, leaders: 2, gtmOps: null, total: 22 }, "mix with nulls");
eq(c.hasData, true, "mix counts as data");

// E. channels
c = ctxOf({ communications_channel_company: "slack;sms;video_call;inperson;whatsapp;email;phone;other;carrier_pigeon" });
eq(c.channels.map((x) => x.label), ["Slack", "SMS", "Video call", "In-person", "WhatsApp", "Email", "Phone", "Other", "Carrier pigeon"], "channel labels");
eq(c.channels[0].key, "slack", "channel key");
eq(ctxOf({ communications_channel_company: "" }).channels, [], "no channels");
eq(c.hasRepNotes, true, "channels are rep notes");
eq(ctxOf({ communications_channel_company: "constructor" }).channels[0].label, "constructor", "proto key not leaked");

// E. research
c = ctxOf({ company_research: "<p>Acme &amp; Co sells <b>widgets</b>&nbsp;&nbsp;to   SMBs.</p><p>Uses Apollo &#8212; churn risk &#x2019;26.</p><ul><li>One</li><li>Two</li></ul><br><script>alert(1)</script>&lt;tag&gt; &quot;q&quot; &apos;a&#39;" });
eq(c.researchFull, "Acme & Co sells widgets to SMBs.\nUses Apollo — churn risk ’26.\nOne\nTwo\n<tag> \"q\" 'a'", "research stripped");
eq(c.research, c.researchFull, "short research not truncated");
eq(c.researchTruncated, false, "not truncated flag");
const long = "<p>" + "word ".repeat(200) + "</p>";
c = ctxOf({ company_research: long });
ok(c.researchTruncated === true, "long research truncated");
ok(c.research.length <= D.CONFIG.REASONING_CHARS + 1 && c.research.endsWith("…"), "truncated at REASONING_CHARS");
eq(c.researchFull.length, 999, "full kept");
eq(ctxOf({ company_research: "<p> </p><br>" }).research, null, "empty html research is null");
eq(D.format.htmlToText("a &amp;lt; b"), "a &lt; b", "no double decode");

// E. other rep notes
c = ctxOf({ company_source: "Referral", competitor_tech: "Apollo", missing_wiza_features: "SSO", next_checkin: "2026-10-20" });
eq([c.companySource, c.competitorTech, c.missingFeatures], ["Referral", "Apollo", "SSO"], "rep note fields");
eq(c.nextCheckinOverdue, true, "yesterday overdue");
eq(ctxOf({ next_checkin: "2026-10-21" }).nextCheckinOverdue, false, "today not overdue");
eq(ctxOf({ next_checkin: "2026-10-28" }).nextCheckinOverdue, false, "future not overdue");
eq(ctxOf({ next_checkin: "2026-10-28" }).nextCheckinAt, Date.UTC(2026, 9, 28), "checkin ms");
eq(ctxOf({}).hasRepNotes, false, "no rep notes");
eq(ctxOf({ missing_wiza_features: "x" }).hasData, true, "rep note counts as data");

// F. wiza usage
let u = D.view.wizaUsage(co({}));
eq(u.hasData, false, "empty usage");
eq([u.accountCreatedAt, u.activeUsers30d, u.creditsUsed30d, u.apiCreditBalance, u.apiCreditsUsed30d, u.apiCreditsPerDay, u.depletionDays, u.depletionTone], [null, null, null, null, null, null, null, null], "nulls omitted");
u = D.view.wizaUsage(co({ number_of_active_users_last_30_days: "0" }));
eq([u.activeUsers30d, u.hasData], [0, false], "lone zero is not data");
eq(D.view.wizaUsage(co({ number_of_active_users_last_30_days: "0", number_of_credits_used_in_last_30_days: "0", api_credit_balance_company: "0", api_credits_used__30_days_cloned: "0", credit_use_per_day_company: "0", wiza_credit_depletion_days_company: "0" })).hasData, false, "all-zero usage is not data");
eq(D.view.wizaUsage(co({ number_of_active_users_last_30_days: "0", credit_use_per_day_company: "2" })).hasData, true, "one >0 field is data");
eq(D.view.wizaUsage(co({ wiza_account_create_date: "2025-01-02T03:04:05Z" })).hasData, true, "create date alone is data");
eq(D.view.wizaUsage(co({ wiza_credit_depletion_days_company: "6" })).depletionTone, "negative", "<7 red");
eq(D.view.wizaUsage(co({ wiza_credit_depletion_days_company: "7" })).depletionTone, "caution", "7 amber");
eq(D.view.wizaUsage(co({ wiza_credit_depletion_days_company: "13.5" })).depletionTone, "caution", "<14 amber");
eq(D.view.wizaUsage(co({ wiza_credit_depletion_days_company: "14" })).depletionTone, null, "14 no tone");
u = D.view.wizaUsage(co({ wiza_account_create_date: "2025-01-02T03:04:05Z", api_credit_balance_company: "500", api_credits_used__30_days_cloned: "40", credit_use_per_day_company: "1.5", number_of_credits_used_in_last_30_days: "900" }));
eq([u.accountCreatedAt, u.apiCreditBalance, u.apiCreditsUsed30d, u.apiCreditsPerDay, u.creditsUsed30d], [Date.parse("2025-01-02T03:04:05Z"), 500, 40, 1.5, 900], "usage values");
eq(D.view.wizaUsage(null).hasData, false, "null company");

// B. contact inbound source
let k = D.view.contact({ id: "9", properties: { firstname: "A", inbound_source: "Abandoned Booking", inbound_source_last_updated: "2026-10-09" } }, null);
eq([k.inboundSource, k.inboundSourceAt], ["Abandoned Booking", Date.UTC(2026, 9, 9)], "contact inbound");
k = D.view.contact({ id: "9", properties: {} }, null);
eq([k.inboundSource, k.inboundSourceAt], [null, null], "contact no inbound");


// Competitor renewal (company) + deal competitor
ok(D.CONFIG.COMPANY_PROPERTIES.includes("competitor_renewal_date"), "company renewal prop");
ok(D.CONFIG.DEAL_PROPERTIES.includes("competitor") && D.CONFIG.DEAL_PROPERTIES.includes("competitor_renewal_date_deal"), "deal props");
c = ctxOf({ competitor_renewal_date: "2026-12-14" });
eq([c.competitorRenewalAt, c.competitorRenewalState, c.hasRepNotes, c.hasData], [Date.UTC(2026, 11, 14), null, true, true], "renewal >30d");
eq(ctxOf({ competitor_renewal_date: "2026-11-20" }).competitorRenewalState, "caution", "30 days = caution");
eq(ctxOf({ competitor_renewal_date: "2026-11-21" }).competitorRenewalState, null, "31 days none");
eq(ctxOf({ competitor_renewal_date: "2026-10-28" }).competitorRenewalState, "negative", "7 days = negative");
eq(ctxOf({ competitor_renewal_date: "2026-10-29" }).competitorRenewalState, "caution", "8 days = caution");
eq(ctxOf({ competitor_renewal_date: "2026-10-21" }).competitorRenewalState, "negative", "today negative");
eq(ctxOf({ competitor_renewal_date: "2026-10-20" }).competitorRenewalState, "past", "past");
eq([ctxOf({}).competitorRenewalAt, ctxOf({}).competitorRenewalState], [null, null], "no renewal");
eq(ctxOf({ competitor_renewal_date_deal: "2026-11-01" }).competitorRenewalAt, null, "no deal fallback");
const dc = D.view.dealCompetitor;
eq(dc({ competitor: "seamlessai", competitor_renewal_date_deal: "2026-11-14" }), { competitor: "Seamless.ai", competitorRenewalAt: Date.UTC(2026, 10, 14) }, "deal key mapped");
eq(["cognism","swordfishai","snovio","anyleads","kaspr","hunterio","other"].map((v) => dc({ competitor: v }).competitor), ["Cognism","Swordfish.ai","Snov.io","AnyLeads","Kaspr","Hunter.io","Other"], "all keys");
eq(dc({ competitor: "ZoomInfo" }).competitor, "ZoomInfo", "label as-is");
eq([dc({ competitor: "Unknown" }).competitor, dc({ competitor: "none" }).competitor, dc({}).competitor, dc(null).competitorRenewalAt], [null, null, null, null], "skip unknown/none/blank");
eq(dc({ competitor: "constructor" }).competitor, "constructor", "proto-safe");

// Local-date rule: "today" is the viewer's local calendar day, compared against
// the property's UTC-midnight millis. 23:30 local on day D must not roll over.
{
  const D0 = new Date(2026, 9, 21, 23, 30, 0).getTime();
  const dayUtc = (off) => Date.UTC(2026, 9, 21 + off);
  const at = (props) => D.view.accountContext(co(props), { now: D0 });
  const overdue = (ms) => at({ next_checkin: String(ms) }).nextCheckinOverdue;
  eq(overdue(dayUtc(0)), false, "due today at 23:30 local is not overdue");
  eq(overdue(dayUtc(-1)), true, "yesterday is overdue at 23:30 local");
  eq(overdue(dayUtc(1)), false, "tomorrow is not overdue");
  const rs = (iso) => at({ competitor_renewal_date: iso }).competitorRenewalState;
  eq(rs("2026-10-21"), "negative", "renewal today at 23:30 local = 0 days left, not past");
  eq(rs("2026-10-20"), "past", "renewal yesterday at 23:30 local is past");
}

// htmlToText: table cells are separated by a space, rows by a newline.
eq(ctxOf({ company_research: "<table><tr><th>Tool</th><th>Seats</th></tr><tr><td>Apollo</td><td>12</td></tr></table>" }).researchFull, "Tool Seats\nApollo 12", "td/th space, tr newline");

// Call intel / Account notes sub-objects (v0.8.1 layout).
{
  const dayIso = (off) => new Date(Date.UTC(2026, 9, 21 + off)).toISOString().slice(0, 10);
  let ci = ctxOf({ competitor_tech: "ZoomInfo", competitor_renewal_date: dayIso(12), next_checkin: dayIso(-2), missing_wiza_features: "SSO" }).callIntel;
  eq([ci.using, ci.renewsHint, ci.renewsState, ci.nextCheckinHint, ci.nextCheckinOverdue, ci.missingFeatures, ci.hasData], ["ZoomInfo", "in 12d", "caution", "overdue", true, "SSO", true], "call intel");
  ci = ctxOf({ competitor_renewal_date: dayIso(-3), next_checkin: dayIso(5) }).callIntel;
  eq([ci.renewsHint, ci.renewsState, ci.nextCheckinHint, ci.nextCheckinOverdue], ["passed", "past", "in 5d", false], "passed renewal, future check-in");
  eq(ctxOf({ next_checkin: dayIso(0) }).callIntel.nextCheckinHint, "today", "check-in today");
  eq(ctxOf({}).callIntel.hasData, false, "empty call intel");
  let an = ctxOf({ company_source: "Referral", communications_channel_company: "slack" }).accountNotes;
  eq([an.source, an.channels.map((c) => c.label), an.research, an.hasData], ["Referral", ["Slack"], null, true], "account notes");
  eq(ctxOf({}).accountNotes.hasData, false, "empty account notes");
  eq(ctxOf({ competitor_tech: "Apollo" }).hasData, true, "call intel alone is data");
}

// Others at this account: one row per person.
{
  const rec = (id, props) => ({ id, properties: props });
  let rows = D.view.accountContacts([rec("2", { firstname: "Ann", email: "a@x.com" }), rec("2", { firstname: "Ann", email: "a@x.com" })], {});
  eq(rows.map((r) => r.id), ["2"], "same id twice -> one row");
  rows = D.view.accountContacts([
    rec("3", { firstname: "Ann", lastname: "Lee", jobtitle: "VP", email: "Ann@X.com", notes_last_contacted: String(NOW - 40 * DAY) }),
    rec("4", { firstname: "Ann", lastname: "Lee", jobtitle: "VP", email: "ann@x.com ", notes_last_contacted: String(NOW - 2 * DAY) }),
    rec("5", { firstname: "Bo", email: "bo@x.com" }),
  ], {});
  eq(rows.map((r) => r.id), ["4", "5"], "same email, different id -> one row, most recently contacted kept");
  rows = D.view.accountContacts([
    rec("6", { firstname: "Cy", lastname: "Ng", jobtitle: "AE", email: "cy@x.com" }),
    rec("7", { firstname: "Cy", lastname: "Ng", jobtitle: "AE", email: "cy.ng@x.com" }),
  ], {});
  eq(rows.map((r) => r.id).sort(), ["6", "7"], "same name, different email -> two rows");
  rows = D.view.accountContacts([rec("8", { firstname: "Di" }), rec("9", { firstname: "Di" })], {});
  eq(rows.length, 2, "no email on either -> both kept");
}


// Wiza tiles: Stripe status dot tone, seats meter, depletion meter.
{
  const T = D.view.stripeDotTone;
  eq(["active", "Active", "trialing", "past_due", "Past due", "unpaid", "incomplete", "canceled", "Cancelled", "", null, "constructor", "something_new"].map(T),
    ["positive", "positive", "positive", "caution", "caution", "caution", "caution", "neutral", "neutral", "neutral", "neutral", "neutral", "neutral"], "stripe dot tones");
  eq(D.view.seatsMeter(1, 1), { used: 1, total: 1, ratio: 1, over: false }, "seats full");
  eq(D.view.seatsMeter("3", "4"), { used: 3, total: 4, ratio: 0.75, over: false }, "seats ratio from strings");
  eq(D.view.seatsMeter(5, 4), { used: 5, total: 4, ratio: 1, over: true }, "seats over, clamped");
  eq(D.view.seatsMeter(2, null), { used: 2, total: null, ratio: null, over: false }, "seats without total");
  eq(D.view.seatsMeter(2, 0), { used: 2, total: null, ratio: null, over: false }, "zero total is no total");
  eq(D.view.seatsMeter(null, 4), null, "no used, no meter");
  eq(D.view.depletionMeter(null), null, "no depletion");
  eq(D.view.depletionMeter(5), { days: 5, tone: "negative", ratio: 5 / 30 }, "depletion red under 7");
  eq(D.view.depletionMeter(7).tone, "caution", "7 days is amber");
  eq(D.view.depletionMeter(13).tone, "caution", "13 days amber");
  eq(D.view.depletionMeter(14).tone, "positive", "14 days green");
  eq(D.view.depletionMeter(90), { days: 90, tone: "positive", ratio: 1 }, "long runway full bar");
  eq(D.view.depletionMeter(0), { days: 0, tone: "negative", ratio: 0 }, "zero runway");
}

// GTM tech (v0.8.1): exact-slug matches against gtm-tech.js's TOOLS.
{
  const TOOLS = sandbox.EB.gtmTech.TOOLS;
  const keys = Object.keys(TOOLS);
  ok(keys.length >= 200, "TOOLS has >= 200 keys: " + keys.length);
  // Snake-ish, not strict snake_case: the portal's enum has one value with
  // parens ("vtrenz_(_silverpop)"), and keys must be the enum values verbatim.
  ok(keys.every((k) => typeof k === "string" && /^[a-z0-9][^\sA-Z;,|]*$/.test(k)), "every TOOLS key is a non-empty snake-ish slug");
  ok(keys.every((k) => TOOLS[k] && typeof TOOLS[k].label === "string" && TOOLS[k].label && typeof TOOLS[k].cat === "string"), "every TOOLS entry has label + cat");
  ok(!TOOLS.wordpress && !TOOLS.jquery && TOOLS.activecampaign && TOOLS.amplitude, "fixture slugs classified as expected");

  let c = ctxOf({ web_technologies: "wordpress;activecampaign;jquery;amplitude" });
  eq(c.gtmTech, [
    { slug: "activecampaign", label: "ActiveCampaign", cat: "Marketing", competitor: false },
    { slug: "amplitude", label: "Amplitude", cat: "Analytics", competitor: false },
  ], "2 GTM of 4: labels from TOOLS, A-Z");
  eq(c.allTech.map((t) => t.label), ["ActiveCampaign", "Amplitude", "jQuery", "WordPress"], "allTech is every value, A-Z");
  eq([c.allTech.length, c.techCount], [4, 4], "allTech length + techCount");
  ok(c.hasData, "tech alone is data");

  c = ctxOf({ web_technologies: "wordpress;jquery" });
  eq([c.gtmTech.length, c.allTech.length, c.techCount, c.hasData], [0, 2, 2, true], "only non-GTM: no gtmTech, still hasData");

  c = ctxOf({ web_technologies: "" });
  eq([c.gtmTech, c.allTech, c.techCount], [[], [], 0], "empty: no tech");
  eq(ctxOf({}).allTech, [], "absent property: no tech");

  // Exact slug only: a label or a near-miss spelling is not a GTM hit.
  eq(ctxOf({ web_technologies: "ActiveCampaign;active_campaign" }).gtmTech, [], "no fuzzy matching");

  // No slug in the portal enum is a COMPETITORS entry today, so the flag can
  // never fire on real data. Synthesize one (zoominfo) in TOOLS for the
  // duration of this check to prove flagging + competitor-first ordering.
  ok(!keys.some((k) => D.tech.isCompetitor(k) || D.tech.isCompetitor(TOOLS[k].label)), "no real TOOLS entry is a competitor");
  TOOLS.zoominfo = { label: "ZoomInfo", cat: "Data" };
  try {
    c = ctxOf({ web_technologies: "amplitude;zoominfo;activecampaign" });
    eq(c.gtmTech.map((t) => [t.slug, t.competitor]), [["zoominfo", true], ["activecampaign", false], ["amplitude", false]], "competitor flagged and sorted first");
  } finally {
    delete TOOLS.zoominfo;
  }

  // A context without gtm-tech.js loaded still yields allTech, no gtmTech.
  const saved = sandbox.EB.gtmTech;
  delete sandbox.EB.gtmTech;
  try {
    c = ctxOf({ web_technologies: "activecampaign;wordpress" });
    eq([c.gtmTech.length, c.allTech.length], [0, 2], "missing EB.gtmTech falls back to an empty map");
  } finally {
    sandbox.EB.gtmTech = saved;
  }
}

// Company Status / Prospecting Status (v0.8.1)
{
  ok(D.CONFIG.COMPANY_PROPERTIES.includes("prospecting_status"), "company prop prospecting_status");
  let c = ctxOf({ company_lifecycle_stage: "Open Deal" });
  eq([c.status, c.statusTone, c.hasData], ["Active Deal", "positive", true], "Open Deal displays as Active Deal, green, is data");
  eq(["New", "Open", "Prospecting", "Customer", "Churned Customer", "Cool Down", "Nurture", "Disqualified"].map((v) => ctxOf({ company_lifecycle_stage: v }).status),
    ["New", "Open", "Prospecting", "Customer", "Churned Customer", "Cool Down", "Nurture", "Disqualified"], "other company statuses as-is");
  eq(["Customer", "Disqualified", "Nurture"].map((v) => ctxOf({ company_lifecycle_stage: v }).statusTone), ["positive", "negative", null], "company status tones");
  c = ctxOf({ prospecting_status: "Ready For Outbound" });
  eq([c.prospectingStatus, c.prospectingStatusTone, c.hasData], ["Ready For Outbound", null, true], "prospecting_status passes through and is data");
  eq(["Do Not Outbound", "Demo Outstanding", "Actively Engaged", "Outreach Initiated"].map((v) => ctxOf({ prospecting_status: v }).prospectingStatusTone),
    ["negative", "positive", "positive", null], "prospecting status tones");
  eq([ctxOf({}).prospectingStatus, ctxOf({}).status, ctxOf({}).hasData], [null, null, false], "neither set: no data");
}

// Call brief (v0.9.0)
{
  ok(D.CONFIG.CONTACT_PROPERTIES.includes("sdr_call_brief"), "contact prop sdr_call_brief");
  ok(D.CONFIG.COMPANY_PROPERTIES.includes("sdr_call_brief"), "company prop sdr_call_brief");
  const brief = [
    "• CALLING: Gerri Alaniz, Community Relations and Business Development Manager – NEW contact, not on the original deal. Last time we spoke with Roxanne Alaniz.",
    "• LOST: Oct 2025 at Validation stage ($4,788) – Timing Issue",
    "• WHY WE LOST: Busy launching campaigns and hiring; felt set on lists for now.",
    "• LAST TOUCH: 2026-11-02 – Matt called Roxanne Alaniz – no answer · since Oct 29: 2 dials, no conversation · AE on deal: McKenna Sivula (inactive)",
    "• ANGLE: They asked us to come back and we didn't – own the gap and reopen.",
  ].join("\n");
  const items = D.view.callBrief(brief);
  eq(items.length, 5, "example parses to 5 items");
  eq(items.map((i) => i.label), ["CALLING", "LOST", "WHY WE LOST", "LAST TOUCH", "ANGLE"], "example labels");
  eq(items[1].text, "Oct 2025 at Validation stage ($4,788) – Timing Issue", "text after the first colon");
  eq(items[3].text, "2026-11-02 – Matt called Roxanne Alaniz – no answer · since Oct 29: 2 dials, no conversation · AE on deal: McKenna Sivula (inactive)", "inline · and later colons stay in the text");
  eq(D.view.callBrief("LOST: Oct 2025\nANGLE: reopen"), [{ label: "LOST", text: "Oct 2025" }, { label: "ANGLE", text: "reopen" }], "no bullet prefix");
  eq(D.view.callBrief("- LOST: Oct 2025\n* ANGLE: reopen"), [{ label: "LOST", text: "Oct 2025" }, { label: "ANGLE", text: "reopen" }], "- and * bullets");
  eq(D.view.callBrief("• LOST: Oct 2025\r\n\r\n• ANGLE: reopen\r\n"), [{ label: "LOST", text: "Oct 2025" }, { label: "ANGLE", text: "reopen" }], "CRLF and blank lines");
  eq(D.view.callBrief("• Call them back after the holidays"), [{ label: null, text: "Call them back after the holidays" }], "no colon: label null");
  eq(D.view.callBrief("• Note: lowercase is not a label"), [{ label: null, text: "Note: lowercase is not a label" }], "mixed-case prefix is not a label");
  eq(D.view.callBrief("<p>• LOST: Oct 2025 &amp; again</p><p>• ANGLE: <b>reopen</b></p>"), [{ label: "LOST", text: "Oct 2025 & again" }, { label: "ANGLE", text: "reopen" }], "HTML input");
  eq([D.view.callBrief(""), D.view.callBrief(null), D.view.callBrief(undefined), D.view.callBrief("  \n \r\n")], [[], [], [], []], "empty input is []");
  eq(D.view.contact({ id: "1", properties: { sdr_call_brief: "• LOST: Oct 2025" } }, null).callBrief, [{ label: "LOST", text: "Oct 2025" }], "contact view carries callBrief");
  eq(D.view.company({ id: "2", properties: {} }, null).callBrief, [], "company view with no brief");
}

// Activity fetch hardening (v0.9.0)
{
  const A = D.activity;
  eq([D.CONFIG.ACTIVITY_ASSOC_MAX, D.CONFIG.ACTIVITY_ASSOC_READ, D.CONFIG.ACTIVITY_DEAL_MAX], [500, 100, 10], "assoc constants");
  ok(D.CONFIG.ACTIVITY_ASSOC_READ <= D.CONFIG.ACTIVITY_ASSOC_MAX, "read <= collected");
  // merge, dedupe, numeric-desc sort, top N
  eq(A.topIds([["9", "10", "100"], ["10", "2"], null, ["x", "", "100"]], 3), ["100", "10", "9"], "merge dedupe numeric sort top 3");
  eq(A.topIds([["99999999999999999", "100000000000000000"]], 1), ["100000000000000000"], "exact past 2^53");
  eq(A.topIds([[1, "3", 2]]), ["3", "2", "1"], "no max keeps all");
  eq(A.topIds([], 5), [], "empty");
  eq(A.topIds([["5", "4"]], 0), [], "max 0");
  // paging cursor
  eq(A.nextAfter({ paging: { next: { after: "MTAw" } } }), "MTAw", "next after");
  eq([A.nextAfter({ results: [] }), A.nextAfter(null), A.nextAfter({ paging: { next: { after: "" } } })], [null, null, null], "last page");
  // v4 batch association read
  eq(A.batchIds({ results: [{ from: { id: "1" }, to: [{ toObjectId: 5 }, { toObjectId: "7" }] }, { from: { id: "2" }, to: [{ toObjectId: "7" }, { id: "3" }] }, { from: { id: "3" } }] }), ["7", "5", "3"], "batch ids merged and deduped");
  eq(A.batchIds(null), [], "batch ids null");
  // failure shape + text
  const f403 = A.failure("notes", { status: 403, code: "FORBIDDEN" }, false);
  eq(f403, { type: "notes", status: 403, code: "FORBIDDEN", partial: false }, "failure shape");
  eq(A.failureText(f403), "Notes unavailable (HTTP 403)", "failure text");
  eq(A.failureText(A.failure("emails", { code: "TRANSIENT" }, true)), "Some company or deal emails unavailable (Transient)", "partial failure text");
  eq(A.failure("calls", null, false), { type: "calls", status: null, code: "TRANSIENT", partial: false }, "failure with no error");
  eq(A.failureText(null), "", "no failure text");
  // tabs: an outright failure is not a disabled 0; a partial keeps its count
  const items = [{ type: "calls", id: "1", timestamp: 2 }, { type: "calls", id: "2", timestamp: 1 }];
  const tabs = A.tabs(items, [f403, A.failure("calls", { status: 500 }, true)]);
  const notes = tabs.find((t) => t.key === "notes");
  eq([notes.count, notes.disabled, notes.unavailable], [0, false, true], "failed notes tab enabled, unavailable");
  const calls = tabs.find((t) => t.key === "calls");
  eq([calls.count, calls.disabled, calls.unavailable, calls.failure.partial], [2, false, false, true], "partial calls tab keeps count");
  eq(tabs.find((t) => t.key === "tasks").disabled, true, "untouched empty tab still disabled");
  eq(A.tabs(items).find((t) => t.key === "notes").disabled, true, "no failures: old behavior");
  eq(A.resolveTab(items, "notes", [f403]), "notes", "failed tab can stay selected");
  eq(A.resolveTab(items, "notes"), "all", "empty tab without failure falls back");
  // every engagement type has a scope, and every scope is requested
  const types = D.CONFIG.ACTIVITY_TYPES.map((s) => s.type);
  eq(Object.keys(D.CONFIG.ACTIVITY_SCOPES).sort(), [...types].sort(), "ACTIVITY_SCOPES covers exactly ACTIVITY_TYPES");
  const cfgBox = { console: { ...console, error() {}, debug() {} }, chrome: { runtime: { id: "test" } }, URL };
  cfgBox.self = cfgBox; cfgBox.window = cfgBox;
  vm.createContext(cfgBox);
  vm.runInContext(fs.readFileSync(ROOT + "hubspot-config.js", "utf8"), cfgBox, { filename: "hubspot-config.js" });
  const scopes = cfgBox.EB.hubspotConfig.SCOPES;
  for (const t of types) ok(scopes.includes(D.CONFIG.ACTIVITY_SCOPES[t]), `scope for ${t} is requested`);
  const appScopes = JSON.parse(fs.readFileSync(ROOT + "hubspot-app/src/app/app-hsmeta.json", "utf8")).config.auth.requiredScopes;
  eq(appScopes, Array.from(scopes), "app requiredScopes match SCOPES, same order");
}

console.log(`PASS: ${n} assertions`);
