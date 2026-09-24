USE e2eechat;

CREATE TABLE IF NOT EXISTS robot_article_views (
  article_id BIGINT UNSIGNED NOT NULL,
  user_id BIGINT UNSIGNED NOT NULL,
  view_count INT UNSIGNED NOT NULL DEFAULT 1,
  first_viewed_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_viewed_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (article_id, user_id),
  INDEX idx_robot_views_recent (article_id, last_viewed_at),
  CONSTRAINT fk_robot_view_article FOREIGN KEY (article_id) REFERENCES robot_articles(id) ON DELETE CASCADE,
  CONSTRAINT fk_robot_view_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
