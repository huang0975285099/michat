USE e2eechat;

ALTER TABLE robot_articles ADD COLUMN source VARCHAR(200) NOT NULL DEFAULT '';

UPDATE robot_articles
SET source = TRIM(SUBSTRING(summary, 4)), summary = ''
WHERE source = '' AND summary LIKE '来源：%' AND CHAR_LENGTH(summary) <= 200;
