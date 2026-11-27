-- crash-dash — purge BUND's retired Bundesbank component rows.
-- BUND's 10y leg is now OAT's CMP_OAT_DE10Y and its 2y leg CMP_BUND_DE2Y; nothing reads these two ids.
-- destructive: reviewed deletes only the retired CMP_BUND_Y10/CMP_BUND_Y02 component rows — derived from the dormant Bundesbank feed, rebuildable via fetchBundYield.
delete from readings
where indicator_id in ('CMP_BUND_Y10', 'CMP_BUND_Y02');
