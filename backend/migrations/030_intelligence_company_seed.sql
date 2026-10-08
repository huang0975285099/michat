USE e2eechat;

-- Official company websites checked on 2026-09-27. Replaying this file does not overwrite editor changes.
CREATE TABLE IF NOT EXISTS intelligence_seed_runs (
  seed_key VARCHAR(80) NOT NULL PRIMARY KEY,
  applied_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

INSERT INTO intelligence_companies(slug,name_zh,name_en,aliases_json,region,focus,description,website,active)
VALUES('tesla','特斯拉','Tesla','[]','','人形机器人、AI','研发 Optimus 通用双足人形机器人。','https://www.tesla.com/',1)
ON DUPLICATE KEY UPDATE intelligence_companies.id=intelligence_companies.id;

INSERT INTO intelligence_companies(slug,name_zh,name_en,aliases_json,region,focus,description,website,active)
VALUES('figure','','Figure','["Figure AI"]','','通用人形机器人、具身 AI','研发通用人形机器人及其智能系统。','https://www.figure.ai/',1)
ON DUPLICATE KEY UPDATE intelligence_companies.id=intelligence_companies.id;

INSERT INTO intelligence_companies(slug,name_zh,name_en,aliases_json,region,focus,description,website,active)
VALUES('1x','','1X','["1X Technologies"]','','家庭人形机器人','研发面向家庭场景的 NEO 机器人。','https://www.1x.tech/',1)
ON DUPLICATE KEY UPDATE intelligence_companies.id=intelligence_companies.id;

INSERT INTO intelligence_companies(slug,name_zh,name_en,aliases_json,region,focus,description,website,active)
VALUES('boston-dynamics','波士顿动力','Boston Dynamics','[]','','移动机器人、工业人形机器人','研发移动机器人及 Atlas 人形机器人。','https://bostondynamics.com/',1)
ON DUPLICATE KEY UPDATE intelligence_companies.id=intelligence_companies.id;

INSERT INTO intelligence_companies(slug,name_zh,name_en,aliases_json,region,focus,description,website,active)
VALUES('unitree','宇树科技','Unitree Robotics','["Unitree"]','','人形机器人、四足机器人','研发 G1 等人形机器人和四足机器人。','https://www.unitree.com/',1)
ON DUPLICATE KEY UPDATE intelligence_companies.id=intelligence_companies.id;

INSERT INTO intelligence_companies(slug,name_zh,name_en,aliases_json,region,focus,description,website,active)
VALUES('agibot','智元机器人','AGIBOT','["智元"]','','人形机器人、具身智能数据','研发人形机器人并提供具身智能相关数据服务。','https://www.agibot.com/',1)
ON DUPLICATE KEY UPDATE intelligence_companies.id=intelligence_companies.id;

INSERT INTO intelligence_company_sources(company_id,kind,label,url,url_hash)
SELECT id,'website','AI & Robotics','https://www.tesla.com/AI',SHA2('https://www.tesla.com/AI',256) FROM intelligence_companies WHERE slug='tesla' AND NOT EXISTS(SELECT 1 FROM intelligence_seed_runs WHERE seed_key='company-sources-2026-09-27')
ON DUPLICATE KEY UPDATE intelligence_company_sources.id=intelligence_company_sources.id;

INSERT INTO intelligence_company_sources(company_id,kind,label,url,url_hash)
SELECT id,'blog','Figure News','https://www.figure.ai/news',SHA2('https://www.figure.ai/news',256) FROM intelligence_companies WHERE slug='figure' AND NOT EXISTS(SELECT 1 FROM intelligence_seed_runs WHERE seed_key='company-sources-2026-09-27')
ON DUPLICATE KEY UPDATE intelligence_company_sources.id=intelligence_company_sources.id;

INSERT INTO intelligence_company_sources(company_id,kind,label,url,url_hash)
SELECT id,'blog','1X Stories','https://www.1x.tech/discover',SHA2('https://www.1x.tech/discover',256) FROM intelligence_companies WHERE slug='1x' AND NOT EXISTS(SELECT 1 FROM intelligence_seed_runs WHERE seed_key='company-sources-2026-09-27')
ON DUPLICATE KEY UPDATE intelligence_company_sources.id=intelligence_company_sources.id;

INSERT INTO intelligence_company_sources(company_id,kind,label,url,url_hash)
SELECT id,'blog','Boston Dynamics News','https://bostondynamics.com/news/',SHA2('https://bostondynamics.com/news/',256) FROM intelligence_companies WHERE slug='boston-dynamics' AND NOT EXISTS(SELECT 1 FROM intelligence_seed_runs WHERE seed_key='company-sources-2026-09-27')
ON DUPLICATE KEY UPDATE intelligence_company_sources.id=intelligence_company_sources.id;

INSERT INTO intelligence_company_sources(company_id,kind,label,url,url_hash)
SELECT id,'blog','Unitree News Center','https://www.unitree.com/news/',SHA2('https://www.unitree.com/news/',256) FROM intelligence_companies WHERE slug='unitree' AND NOT EXISTS(SELECT 1 FROM intelligence_seed_runs WHERE seed_key='company-sources-2026-09-27')
ON DUPLICATE KEY UPDATE intelligence_company_sources.id=intelligence_company_sources.id;

INSERT INTO intelligence_company_sources(company_id,kind,label,url,url_hash)
SELECT id,'blog','AGIBOT Newsroom','https://www.agibot.com/news',SHA2('https://www.agibot.com/news',256) FROM intelligence_companies WHERE slug='agibot' AND NOT EXISTS(SELECT 1 FROM intelligence_seed_runs WHERE seed_key='company-sources-2026-09-27')
ON DUPLICATE KEY UPDATE intelligence_company_sources.id=intelligence_company_sources.id;

INSERT INTO intelligence_seed_runs(seed_key) VALUES('company-sources-2026-09-27')
ON DUPLICATE KEY UPDATE seed_key=seed_key;
