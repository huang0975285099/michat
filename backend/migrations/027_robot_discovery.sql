USE e2eechat;

ALTER TABLE robot_articles ADD COLUMN category VARCHAR(64) NOT NULL DEFAULT '';
ALTER TABLE robot_articles ADD COLUMN tags VARCHAR(500) NOT NULL DEFAULT '';
ALTER TABLE robot_articles ADD COLUMN cover_url VARCHAR(200) NOT NULL DEFAULT '';
ALTER TABLE robot_articles ADD COLUMN pinned TINYINT(1) NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS robot_article_bookmarks (
  article_id BIGINT UNSIGNED NOT NULL,
  user_id BIGINT UNSIGNED NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (article_id, user_id),
  INDEX idx_robot_bookmarks_user (user_id, created_at),
  CONSTRAINT fk_robot_bookmark_article FOREIGN KEY (article_id) REFERENCES robot_articles(id) ON DELETE CASCADE,
  CONSTRAINT fk_robot_bookmark_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
