package handler

import (
	"database/sql"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"

	"e2eechat/internal/middleware"
	"github.com/gin-gonic/gin"
)

type RobotHandler struct {
	db       *sql.DB
	mediaDir string
}

type robotArticle struct {
	ID          int64      `json:"id"`
	Title       string     `json:"title"`
	Summary     string     `json:"summary"`
	Content     string     `json:"content,omitempty"`
	Published   bool       `json:"published"`
	PublishedAt *time.Time `json:"published_at"`
	ViewerCount int64      `json:"viewer_count,omitempty"`
	Category    string     `json:"category"`
	Tags        []string   `json:"tags"`
	CoverURL    string     `json:"cover_url"`
	Pinned      bool       `json:"pinned"`
	Read        bool       `json:"read"`
	Bookmarked  bool       `json:"bookmarked"`
}

func NewRobotHandler(db *sql.DB) *RobotHandler { return &RobotHandler{db: db} }
func (h *RobotHandler) SetMediaDir(dir string) { h.mediaDir = dir }

func (h *RobotHandler) List(c *gin.Context) {
	admin := c.FullPath() == "/api/admin/robot/articles"
	userID := c.GetUint64(middleware.CtxUserID)
	limit := 20
	if admin {
		limit = 100
	}
	if raw := c.Query("limit"); raw != "" {
		parsed, err := strconv.Atoi(raw)
		if err != nil || parsed < 1 || parsed > 100 {
			c.JSON(400, gin.H{"error": "invalid limit"})
			return
		}
		limit = parsed
	}
	offset := 0
	if raw := c.Query("offset"); raw != "" {
		parsed, err := strconv.Atoi(raw)
		if err != nil || parsed < 0 || parsed > 1000000 {
			c.JSON(400, gin.H{"error": "invalid offset"})
			return
		}
		offset = parsed
	}
	query := `SELECT a.id,a.title,a.summary,a.published,a.published_at,a.category,a.tags,a.cover_url,a.pinned`
	args := make([]any, 0)
	if admin {
		query += `,(SELECT COUNT(*) FROM robot_article_views WHERE article_id=a.id)`
	}
	if userID != 0 {
		query += `,EXISTS(SELECT 1 FROM robot_article_views WHERE article_id=a.id AND user_id=?),EXISTS(SELECT 1 FROM robot_article_bookmarks WHERE article_id=a.id AND user_id=?)`
		args = append(args, userID, userID)
	}
	query += ` FROM robot_articles a WHERE 1=1`
	if !admin {
		query += ` AND a.published=1`
	}
	if category := strings.TrimSpace(c.Query("category")); category != "" {
		query += ` AND a.category=?`
		args = append(args, category)
	}
	if tag := strings.TrimSpace(c.Query("tag")); tag != "" {
		query += ` AND FIND_IN_SET(?,a.tags)>0`
		args = append(args, tag)
	}
	if search := strings.TrimSpace(c.Query("search")); search != "" {
		if len([]rune(search)) > 100 {
			c.JSON(400, gin.H{"error": "search too long"})
			return
		}
		query += ` AND (a.title LIKE ? OR a.summary LIKE ?)`
		pattern := "%" + search + "%"
		args = append(args, pattern, pattern)
	}
	if c.Query("bookmarked") == "1" {
		if userID == 0 {
			c.Status(401)
			return
		}
		query += ` AND EXISTS(SELECT 1 FROM robot_article_bookmarks WHERE article_id=a.id AND user_id=?)`
		args = append(args, userID)
	}
	query += ` ORDER BY a.pinned DESC,a.published_at DESC,a.id DESC LIMIT ? OFFSET ?`
	args = append(args, limit+1, offset)
	rows, err := h.db.QueryContext(c.Request.Context(), query, args...)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "database error"})
		return
	}
	defer rows.Close()
	articles := make([]robotArticle, 0)
	rowCount := 0
	for rows.Next() {
		rowCount++
		var a robotArticle
		var published int
		var date sql.NullTime
		var tags string
		var pinned int
		fields := []any{&a.ID, &a.Title, &a.Summary, &published, &date, &a.Category, &tags, &a.CoverURL, &pinned}
		if admin {
			fields = append(fields, &a.ViewerCount)
		}
		var read, bookmarked int
		if userID != 0 {
			fields = append(fields, &read, &bookmarked)
		}
		if err := rows.Scan(fields...); err != nil {
			c.JSON(500, gin.H{"error": "database error"})
			return
		}
		a.Published = published != 0
		a.Pinned = pinned != 0
		a.Read = read != 0
		a.Bookmarked = bookmarked != 0
		a.Tags = splitRobotTags(tags)
		if date.Valid {
			a.PublishedAt = &date.Time
		}
		if len(articles) < limit {
			articles = append(articles, a)
		}
	}
	if rows.Err() != nil {
		c.JSON(500, gin.H{"error": "database error"})
		return
	}
	// Query one extra row to avoid a separate COUNT on every feed request.
	c.JSON(200, gin.H{"articles": articles, "has_more": rowCount > limit})
}

func splitRobotTags(value string) []string {
	if value == "" {
		return []string{}
	}
	return strings.Split(value, ",")
}

func (h *RobotHandler) Filters(c *gin.Context) {
	rows, err := h.db.QueryContext(c.Request.Context(), `SELECT category,tags FROM robot_articles WHERE published=1`)
	if err != nil {
		c.JSON(500, gin.H{"error": "database error"})
		return
	}
	defer rows.Close()
	categories, tags := map[string]bool{}, map[string]bool{}
	for rows.Next() {
		var category, rawTags string
		if err := rows.Scan(&category, &rawTags); err != nil {
			c.JSON(500, gin.H{"error": "database error"})
			return
		}
		if category != "" {
			categories[category] = true
		}
		for _, tag := range splitRobotTags(rawTags) {
			tags[tag] = true
		}
	}
	if rows.Err() != nil {
		c.JSON(500, gin.H{"error": "database error"})
		return
	}
	categoryList, tagList := make([]string, 0, len(categories)), make([]string, 0, len(tags))
	for value := range categories {
		categoryList = append(categoryList, value)
	}
	for value := range tags {
		tagList = append(tagList, value)
	}
	sort.Strings(categoryList)
	sort.Strings(tagList)
	c.JSON(200, gin.H{"categories": categoryList, "tags": tagList})
}

func (h *RobotHandler) GetState(c *gin.Context) {
	id, err := strconv.ParseInt(c.Param("id"), 10, 64)
	if err != nil || id < 1 {
		c.Status(404)
		return
	}
	var read, bookmarked int
	err = h.db.QueryRowContext(c.Request.Context(), `SELECT EXISTS(SELECT 1 FROM robot_article_views WHERE article_id=a.id AND user_id=?),EXISTS(SELECT 1 FROM robot_article_bookmarks WHERE article_id=a.id AND user_id=?) FROM robot_articles a WHERE a.id=? AND a.published=1`, c.GetUint64(middleware.CtxUserID), c.GetUint64(middleware.CtxUserID), id).Scan(&read, &bookmarked)
	if err == sql.ErrNoRows {
		c.Status(404)
		return
	}
	if err != nil {
		c.JSON(500, gin.H{"error": "database error"})
		return
	}
	c.JSON(200, gin.H{"read": read != 0, "bookmarked": bookmarked != 0})
}

func (h *RobotHandler) Bookmark(c *gin.Context) {
	id, err := strconv.ParseInt(c.Param("id"), 10, 64)
	if err != nil || id < 1 {
		c.Status(404)
		return
	}
	result, err := h.db.ExecContext(c.Request.Context(), `INSERT INTO robot_article_bookmarks(article_id,user_id) SELECT id,? FROM robot_articles WHERE id=? AND published=1 ON DUPLICATE KEY UPDATE article_id=article_id`, c.GetUint64(middleware.CtxUserID), id)
	if err != nil {
		c.JSON(500, gin.H{"error": "database error"})
		return
	}
	n, _ := result.RowsAffected()
	if n == 0 {
		var exists int
		if h.db.QueryRowContext(c.Request.Context(), `SELECT COUNT(*) FROM robot_articles WHERE id=? AND published=1`, id).Scan(&exists) != nil || exists == 0 {
			c.Status(404)
			return
		}
	}
	c.Status(204)
}

func (h *RobotHandler) Unbookmark(c *gin.Context) {
	id, err := strconv.ParseInt(c.Param("id"), 10, 64)
	if err != nil || id < 1 {
		c.Status(404)
		return
	}
	_, err = h.db.ExecContext(c.Request.Context(), `DELETE FROM robot_article_bookmarks WHERE article_id=? AND user_id=?`, id, c.GetUint64(middleware.CtxUserID))
	if err != nil {
		c.JSON(500, gin.H{"error": "database error"})
		return
	}
	c.Status(204)
}

func (h *RobotHandler) Get(c *gin.Context) {
	id, err := strconv.ParseInt(c.Param("id"), 10, 64)
	if err != nil || id < 1 {
		c.Status(404)
		return
	}
	query := "SELECT id,title,summary,content,published,published_at,category,tags,cover_url,pinned FROM robot_articles WHERE id=?"
	if c.FullPath() != "/api/admin/robot/articles/:id" {
		query += " AND published=1"
	}
	var a robotArticle
	var published int
	var pinned int
	var tags string
	var date sql.NullTime
	err = h.db.QueryRowContext(c.Request.Context(), query, id).Scan(&a.ID, &a.Title, &a.Summary, &a.Content, &published, &date, &a.Category, &tags, &a.CoverURL, &pinned)
	if err == sql.ErrNoRows {
		c.Status(404)
		return
	}
	if err != nil {
		c.JSON(500, gin.H{"error": "database error"})
		return
	}
	a.Published = published != 0
	a.Pinned = pinned != 0
	a.Tags = splitRobotTags(tags)
	if date.Valid {
		a.PublishedAt = &date.Time
	}
	a.Content = sanitizeRobotContent(a.Content)
	c.JSON(200, a)
}

type robotInput struct {
	Title     string   `json:"title"`
	Summary   string   `json:"summary"`
	Content   string   `json:"content"`
	Published bool     `json:"published"`
	Category  string   `json:"category"`
	Tags      []string `json:"tags"`
	CoverURL  string   `json:"cover_url"`
	Pinned    bool     `json:"pinned"`
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
	input.Category = strings.TrimSpace(input.Category)
	input.CoverURL = strings.TrimSpace(input.CoverURL)
	if input.CoverURL != "" && (!validRobotMediaURL(input.CoverURL) || strings.HasSuffix(input.CoverURL, ".mp4") || strings.HasSuffix(input.CoverURL, ".webm")) {
		c.JSON(400, gin.H{"error": "invalid cover"})
		return input, false
	}
	if len([]rune(input.Category)) > 64 || strings.Contains(input.Category, ",") || len(input.Tags) > 10 {
		c.JSON(400, gin.H{"error": "invalid category or tags"})
		return input, false
	}
	seen := make(map[string]bool)
	cleanTags := make([]string, 0, len(input.Tags))
	for _, tag := range input.Tags {
		tag = strings.TrimSpace(tag)
		if tag == "" || len([]rune(tag)) > 30 || strings.Contains(tag, ",") {
			c.JSON(400, gin.H{"error": "invalid tags"})
			return input, false
		}
		if !seen[tag] {
			seen[tag] = true
			cleanTags = append(cleanTags, tag)
		}
	}
	input.Tags = cleanTags
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
	result, err := h.db.ExecContext(c.Request.Context(), `INSERT INTO robot_articles(title,summary,content,published,published_at,category,tags,cover_url,pinned) VALUES(?,?,?,?,IF(?=1,NOW(),NULL),?,?,?,?)`, input.Title, input.Summary, input.Content, input.Published, input.Published, input.Category, strings.Join(input.Tags, ","), input.CoverURL, input.Pinned)
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
	var oldContent, oldCover string
	if err := h.db.QueryRowContext(c.Request.Context(), `SELECT content,cover_url FROM robot_articles WHERE id=?`, id).Scan(&oldContent, &oldCover); err == sql.ErrNoRows {
		c.Status(404)
		return
	} else if err != nil {
		c.JSON(500, gin.H{"error": "database error"})
		return
	}
	result, err := h.db.ExecContext(c.Request.Context(), `UPDATE robot_articles SET title=?,summary=?,content=?,published=?,published_at=CASE WHEN ?=0 THEN NULL WHEN published_at IS NULL THEN NOW() ELSE published_at END,category=?,tags=?,cover_url=?,pinned=? WHERE id=?`, input.Title, input.Summary, input.Content, input.Published, input.Published, input.Category, strings.Join(input.Tags, ","), input.CoverURL, input.Pinned, id)
	if err != nil {
		c.JSON(500, gin.H{"error": "database error"})
		return
	}
	n, _ := result.RowsAffected()
	if n == 0 {
		// MySQL reports zero affected rows when the submitted article is unchanged.
		c.Status(204)
		return
	}
	h.cleanupRobotMedia(c, oldContent, oldCover)
	c.Status(204)
}

func (h *RobotHandler) Delete(c *gin.Context) {
	id, err := strconv.ParseInt(c.Param("id"), 10, 64)
	if err != nil || id < 1 {
		c.Status(404)
		return
	}
	var oldContent, oldCover string
	if err := h.db.QueryRowContext(c.Request.Context(), `SELECT content,cover_url FROM robot_articles WHERE id=?`, id).Scan(&oldContent, &oldCover); err == sql.ErrNoRows {
		c.Status(404)
		return
	} else if err != nil {
		c.JSON(500, gin.H{"error": "database error"})
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
	h.cleanupRobotMedia(c, oldContent, oldCover)
	c.Status(204)
}

var robotMediaRef = regexp.MustCompile(`/api/robot/media/[a-f0-9]{32}\.(?:jpg|png|gif|webp|mp4|webm)`)

func (h *RobotHandler) cleanupRobotMedia(c *gin.Context, content, cover string) {
	if h.mediaDir == "" {
		return
	}
	refs := make(map[string]bool)
	for _, url := range robotMediaRef.FindAllString(content+" "+cover, -1) {
		refs[url] = true
	}
	for url := range refs {
		var count int
		err := h.db.QueryRowContext(c.Request.Context(), `SELECT COUNT(*) FROM robot_articles WHERE content LIKE ? OR cover_url=?`, "%"+url+"%", url).Scan(&count)
		if err != nil {
			log.Printf("robot media reference check: %v", err)
			continue
		}
		if count == 0 {
			name := strings.TrimPrefix(url, "/api/robot/media/")
			if err := os.Remove(filepath.Join(h.mediaDir, name)); err != nil && !os.IsNotExist(err) {
				log.Printf("robot media cleanup: %v", err)
			}
		}
	}
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
