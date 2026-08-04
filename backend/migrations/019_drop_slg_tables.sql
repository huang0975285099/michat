-- Remove offline SLG game data.
-- Delete the subtables first, and then delete the main world table in order of dependency.
DROP TABLE IF EXISTS slg_marches;
DROP TABLE IF EXISTS slg_territories;
DROP TABLE IF EXISTS slg_players;
DROP TABLE IF EXISTS slg_worlds;
