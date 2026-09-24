package handler

import (
	"database/sql"
	"net/http"
	"strconv"
	"strings"
	"time"

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
}

func NewRobotHandler(db *sql.DB) *RobotHandler { return &RobotHandler{db: db} }

func (h *RobotHandler) List(c *gin.Context) {
	admin := c.FullPath() == "/api/admin/robot/articles"
	query := "SELECT id,title,summary,published,published_at FROM robot_articles"
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
		if err := rows.Scan(&a.ID, &a.Title, &a.Summary, &published, &date); err != nil {
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
