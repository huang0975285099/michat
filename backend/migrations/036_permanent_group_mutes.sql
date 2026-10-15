UPDATE group_members SET muted_until = NULL WHERE muted_until <= CURRENT_TIMESTAMP(3);
UPDATE group_members SET muted_until = '9999-12-31 00:00:00.000' WHERE muted_until IS NOT NULL;
