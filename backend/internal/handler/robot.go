package handler

import (
	"database/sql"
	"net/http"
	"strconv"
	"strings"
	"time"

	"e2eechat/internal/middleware"
	"github.com/gin-gonic/gin"
)

type RobotHandler struct{ db *sql.DB }

type robotArticle struct {
	ID          int64      `json:"id"`
	Title       string     `json:"title"`
	Summary     string     `json:"summary"`
	Content     string     `json:"content,omitempty"`
	Published   bool       `json:"published"`
	PublishedAt *time.Time `json:"published_at"`
	ViewerCount int64      `json:"viewer_count,omitempty"`
}

func NewRobotHandler(db *sql.DB) *RobotHandler { return &RobotHandler{db: db} }

func (h *RobotHandler) List(c *gin.Context) {
	admin := c.FullPath() == "/api/admin/robot/articles"
	query := "SELECT id,title,summary,published,published_at"
	if admin {
		query += ", (SELECT COUNT(*) FROM robot_article_views WHERE article_id = robot_articles.id)"
	}
	query += " FROM robot_articles"
	if !admin {
		query += " WHERE published = 1"
	}
	query += " ORDER BY published_at DESC, id DESC LIMIT 100"
	rows, err := h.db.QueryContext(c.Request.Context(), query)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "database error"})
		return
	}
	defer rows.Close()
	articles := make([]robotArticle, 0)
	for rows.Next() {
		var a robotArticle
		var published int
		var date sql.NullTime
		fields := []any{&a.ID, &a.Title, &a.Summary, &published, &date}
		if admin {
			fields = append(fields, &a.ViewerCount)
		}
		if err := rows.Scan(fields...); err != nil {
			c.JSON(500, gin.H{"error": "database error"})
			return
		}
		a.Published = published != 0
		if date.Valid {
			a.PublishedAt = &date.Time
		}
		articles = append(articles, a)
	}
	if rows.Err() != nil {
		c.JSON(500, gin.H{"error": "database error"})
		return
	}
	c.JSON(200, gin.H{"articles": articles})
}

func (h *RobotHandler) Get(c *gin.Context) {
	id, err := strconv.ParseInt(c.Param("id"), 10, 64)
	if err != nil || id < 1 {
		c.Status(404)
		return
	}
	query := "SELECT id,title,summary,content,published,published_at FROM robot_articles WHERE id=?"
	if c.FullPath() != "/api/admin/robot/articles/:id" {
		query += " AND published=1"
	}
	var a robotArticle
	var published int
	var date sql.NullTime
	err = h.db.QueryRowContext(c.Request.Context(), query, id).Scan(&a.ID, &a.Title, &a.Summary, &a.Content, &published, &date)
	if err == sql.ErrNoRows {
		c.Status(404)
		return
	}
	if err != nil {
		c.JSON(500, gin.H{"error": "database error"})
		return
	}
	a.Published = published != 0
	if date.Valid {
		a.PublishedAt = &date.Time
	}
	a.Content = sanitizeRobotContent(a.Content)
	c.JSON(200, a)
}

type robotInput struct {
	Title     string `json:"title"`
	Summary   string `json:"summary"`
	Content   string `json:"content"`
	Published bool   `json:"published"`
}

func readRobotInput(c *gin.Context) (robotInput, bool) {
	var input robotInput
	if err := c.ShouldBindJSON(&input); err != nil {
		c.JSON(400, gin.H{"error": "invalid JSON"})
		return input, false
	}
	input.Title = strings.TrimSpace(input.Title)
	input.Summary = strings.TrimSpace(input.Summary)
	input.Content = strings.TrimSpace(input.Content)
	input.Content = sanitizeRobotContent(input.Content)
	if input.Title == "" || input.Content == "" || len([]rune(input.Title)) > 200 || len([]rune(input.Summary)) > 500 || len(input.Content) > 100000 {
		c.JSON(400, gin.H{"error": "title or content invalid"})
		return input, false
	}
	return input, true
}

func (h *RobotHandler) Create(c *gin.Context) {
	input, ok := readRobotInput(c)
	if !ok {
		return
	}
	result, err := h.db.ExecContext(c.Request.Context(), `INSERT INTO robot_articles(title,summary,content,published,published_at) VALUES(?,?,?,?,IF(?=1,NOW(),NULL))`, input.Title, input.Summary, input.Content, input.Published, input.Published)
	if err != nil {
		c.JSON(500, gin.H{"error": "database error"})
		return
	}
	id, _ := result.LastInsertId()
	c.JSON(201, gin.H{"id": id})
}

func (h *RobotHandler) Update(c *gin.Context) {
	id, err := strconv.ParseInt(c.Param("id"), 10, 64)
	if err != nil || id < 1 {
		c.Status(404)
		return
	}
	input, ok := readRobotInput(c)
	if !ok {
		return
	}
	result, err := h.db.ExecContext(c.Request.Context(), `UPDATE robot_articles SET title=?,summary=?,content=?,published=?,published_at=CASE WHEN ?=0 THEN NULL WHEN published_at IS NULL THEN NOW() ELSE published_at END WHERE id=?`, input.Title, input.Summary, input.Content, input.Published, input.Published, id)
	if err != nil {
		c.JSON(500, gin.H{"error": "database error"})
		return
	}
	n, _ := result.RowsAffected()
	if n == 0 {
		c.Status(404)
		return
	}
	c.Status(204)
}

func (h *RobotHandler) Delete(c *gin.Context) {
	id, err := strconv.ParseInt(c.Param("id"), 10, 64)
	if err != nil || id < 1 {
		c.Status(404)
		return
	}
	result, err := h.db.ExecContext(c.Request.Context(), "DELETE FROM robot_articles WHERE id=?", id)
	if err != nil {
		c.JSON(500, gin.H{"error": "database error"})
		return
	}
	n, _ := result.RowsAffected()
	if n == 0 {
		c.Status(404)
		return
	}
	c.Status(204)
}

// A successful detail-page open records one visit for the signed-in account.
func (h *RobotHandler) RecordView(c *gin.Context) {
	id, err := strconv.ParseInt(c.Param("id"), 10, 64)
	if err != nil || id < 1 {
		c.Status(404)
		return
	}
	userID := c.GetUint64(middleware.CtxUserID)
	if userID == 0 {
		c.Status(401)
		return
	}
	result, err := h.db.ExecContext(c.Request.Context(), `
		INSERT INTO robot_article_views (article_id,user_id,view_count,first_viewed_at,last_viewed_at)
		SELECT id,?,1,NOW(),NOW() FROM robot_articles WHERE id=? AND published=1
		ON DUPLICATE KEY UPDATE view_count=view_count+1,last_viewed_at=NOW()`, userID, id)
	if err != nil {
		c.JSON(500, gin.H{"error": "database error"})
		return
	}
	count, err := result.RowsAffected()
	if err != nil || count == 0 {
		c.Status(404)
		return
	}
	c.Status(204)
}

type robotReader struct {
	ChatID        string    `json:"chat_id"`
	Nickname      string    `json:"nickname"`
	ViewCount     uint64    `json:"view_count"`
	FirstViewedAt time.Time `json:"first_viewed_at"`
	LastViewedAt  time.Time `json:"last_viewed_at"`
}

func (h *RobotHandler) ListViews(c *gin.Context) {
	id, err := strconv.ParseInt(c.Param("id"), 10, 64)
	if err != nil || id < 1 {
		c.Status(404)
		return
	}
	offset := 0
	if raw := c.Query("offset"); raw != "" {
		offset, err = strconv.Atoi(raw)
		if err != nil || offset < 0 || offset > 1000000 {
			c.JSON(400, gin.H{"error": "invalid offset"})
			return
		}
	}
	var title string
	err = h.db.QueryRowContext(c.Request.Context(), "SELECT title FROM robot_articles WHERE id=?", id).Scan(&title)
	if err == sql.ErrNoRows {
		c.Status(404)
		return
	}
	if err != nil {
		c.JSON(500, gin.H{"error": "database error"})
		return
	}
	var totalReaders, totalViews uint64
	err = h.db.QueryRowContext(c.Request.Context(), "SELECT COUNT(*),COALESCE(SUM(view_count),0) FROM robot_article_views WHERE article_id=?", id).Scan(&totalReaders, &totalViews)
	if err != nil {
		c.JSON(500, gin.H{"error": "database error"})
		return
	}
	rows, err := h.db.QueryContext(c.Request.Context(), `
		SELECT u.chat_id,u.nickname,v.view_count,v.first_viewed_at,v.last_viewed_at
		FROM robot_article_views v JOIN users u ON u.id=v.user_id
		WHERE v.article_id=? ORDER BY v.last_viewed_at DESC,v.user_id DESC LIMIT 100 OFFSET ?`, id, offset)
	if err != nil {
		c.JSON(500, gin.H{"error": "database error"})
		return
	}
	defer rows.Close()
	readers := make([]robotReader, 0)
	for rows.Next() {
		var reader robotReader
		if err := rows.Scan(&reader.ChatID, &reader.Nickname, &reader.ViewCount, &reader.FirstViewedAt, &reader.LastViewedAt); err != nil {
			c.JSON(500, gin.H{"error": "database error"})
			return
		}
		readers = append(readers, reader)
	}
	if rows.Err() != nil {
		c.JSON(500, gin.H{"error": "database error"})
		return
	}
	c.Header("Cache-Control", "no-store")
	c.JSON(200, gin.H{"title": title, "total_readers": totalReaders, "total_views": totalViews, "readers": readers})
}
