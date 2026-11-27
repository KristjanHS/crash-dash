# data/

## BAMLH0A0HYM2-vintage.csv (not distributed with this repository)

Full-history vintage of the ICE BofA US High Yield OAS (FRED series `BAMLH0A0HYM2`),
1996-12-31 → 2025-04-10 (~7,400 rows), `date,value` (percent, missing `.` rows dropped).

- **Not distributed with this repository:** code reads it from this path when present
  (`src/hyoas-vintage.ts`); absent, the read handlers degrade and the tests needing it skip.
- **Source and terms:** see `docs/data-licensing.md` §Optional local vintage file.
- **Regenerate locally:** `npx tsx scripts/fetch-hyoas-vintage.ts`
