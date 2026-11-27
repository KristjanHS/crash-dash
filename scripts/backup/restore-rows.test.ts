import { describe, expect, test } from "vitest";

import { parseSnapshotRows, selectRows } from "./restore-rows.js";

const sql =
  "-- header\n" +
  "INSERT INTO public.readings (obs_date,indicator_id,value,delta20,raw_state,state,run_at,decision) VALUES " +
  "('2026-02-05','F17','150.1','0.5','GREEN','GREEN','2026-02-05 22:10:00+00',NULL)," + // Thu
  "('2026-02-06','F17','150.4','0.6','GREEN','GREEN','2026-02-06 22:10:00+00',NULL)," + // Fri, winter: real
  "('2026-02-06','F17','149.0','0.1','GREEN','GREEN','2025-12-01 22:10:00+00',NULL)," + // older vintage of the same date
  "('2026-08-16','F17','147.0','0.2','GREEN','GREEN','2026-08-16 22:10:00+00',NULL)," + // Sun (summer regime)
  "('2026-08-20','F17','147.5','0.3','GREEN','GREEN','2026-08-20 22:10:00+00',NULL)," + // Thu
  "('2026-08-21','F17','147.9','0.4','it''s','GREEN','2026-08-21 22:10:00+00','0.5')," + // Fri ghost (Sunday in week)
  "('2026-09-11','F17','148.0','0.4','GREEN','GREEN','2026-09-11 22:10:00+00',NULL)," + // Fri, beyond target span
  "('2026-02-06','F11','7.1','0.0','GREEN','GREEN','2026-02-06 22:10:00+00',NULL);\n"; // other id

describe("restore-rows", () => {
  test("parses only the wanted ids, unquoting NULL and doubled quotes", () => {
    const rows = parseSnapshotRows(sql, new Set(["F17"]));
    expect(rows).toHaveLength(7);
    expect(rows.find((r) => r.obs_date === "2026-08-21")?.raw_state).toBe("it's"); // doubled quote in a TEXT column
    expect(rows.find((r) => r.obs_date === "2026-08-21")?.decision).toBe("0.5"); // decision is double precision
    expect(rows[0]?.decision).toBeNull();
    expect(parseSnapshotRows(sql, new Set(["F11"]))).toHaveLength(1);
  });

  test("selects the newest vintage of an absent date inside the span; skips present dates, ghosts, out-of-span", () => {
    const rows = parseSnapshotRows(sql, new Set(["F17"]));
    const target = new Map([["F17", new Set(["2026-02-05", "2026-08-16", "2026-08-20", "2026-09-03"])]]);
    const picked = selectRows(rows, { dow: new Set([5, 6]), skipGhostWeeks: true, targetDates: target });
    expect(picked.map((r) => [r.obs_date, r.value])).toEqual([["2026-02-06", "150.4"]]);
  });

  test("without --skip-ghost-weeks the summer Friday comes back", () => {
    const rows = parseSnapshotRows(sql, new Set(["F17"]));
    const target = new Map([["F17", new Set(["2026-02-05", "2026-08-16", "2026-08-20", "2026-09-03"])]]);
    const picked = selectRows(rows, { dow: new Set([5, 6]), skipGhostWeeks: false, targetDates: target });
    expect(picked.map((r) => r.obs_date)).toEqual(["2026-02-06", "2026-08-21"]);
  });

  test("throws when a LATER page's header has extra columns (mixed-vintage snapshot)", () => {
    const mixed =
      sql +
      "INSERT INTO public.readings (obs_date,indicator_id,value,delta20,raw_state,state,run_at,decision,band_cuts) VALUES " +
      "('2026-09-02','F17','148.2','0.4','GREEN','GREEN','2026-09-02 22:10:00+00',NULL,NULL);\n";
    expect(() => parseSnapshotRows(mixed, new Set(["F17"]))).toThrow(/band_cuts/);
  });

  test("an id with no target rows restores nothing (no span to trust)", () => {
    const rows = parseSnapshotRows(sql, new Set(["F11"]));
    expect(selectRows(rows, { skipGhostWeeks: true, targetDates: new Map() })).toEqual([]);
  });
});
