USE e2eechat;

CREATE TABLE IF NOT EXISTS intelligence_companies (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  slug VARCHAR(80) NOT NULL,
  name_zh VARCHAR(120) NOT NULL DEFAULT '',
  name_en VARCHAR(120) NOT NULL DEFAULT '',
  aliases_json TEXT NOT NULL,
  region VARCHAR(100) NOT NULL DEFAULT '',
  focus VARCHAR(200) NOT NULL DEFAULT '',
  description TEXT NOT NULL,
  website VARCHAR(500) NOT NULL DEFAULT '',
  active TINYINT(1) NOT NULL DEFAULT 0,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_intelligence_company_slug (slug),
  INDEX idx_intelligence_company_active (active, name_en, id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS intelligence_company_sources (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  company_id BIGINT UNSIGNED NOT NULL,
  kind VARCHAR(20) NOT NULL,
  label VARCHAR(120) NOT NULL,
  url VARCHAR(500) NOT NULL,
  url_hash CHAR(64) NOT NULL,
  verified_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_intelligence_source_url (company_id, url_hash),
  INDEX idx_intelligence_source_company (company_id, kind),
  CONSTRAINT fk_intelligence_source_company FOREIGN KEY (company_id) REFERENCES intelligence_companies(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

ALTER TABLE robot_articles ADD COLUMN company_id BIGINT UNSIGNED NULL;
ALTER TABLE robot_articles ADD COLUMN source_url VARCHAR(500) NOT NULL DEFAULT '';
ALTER TABLE robot_articles ADD COLUMN occurred_on DATE NULL;
ALTER TABLE robot_articles ADD INDEX idx_robot_articles_company (company_id, published, occurred_on, id);
