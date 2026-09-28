package handler

import (
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net/http"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/go-sql-driver/mysql"
)

var companySlugPattern = regexp.MustCompile(`^[a-z0-9]+(?:-[a-z0-9]+)*$`)

type CompanyHandler struct{ db *sql.DB }

func NewCompanyHandler(db *sql.DB) *CompanyHandler { return &CompanyHandler{db: db} }

type intelligenceCompany struct {
	ID           int64     `json:"id"`
	Slug         string    `json:"slug"`
	NameZh       string    `json:"name_zh"`
	NameEn       string    `json:"name_en"`
	Aliases      []string  `json:"aliases"`
	Region       string    `json:"region"`
	Focus        string    `json:"focus"`
	Description  string    `json:"description"`
	Website      string    `json:"website"`
	Active       bool      `json:"active"`
	ArticleCount int64     `json:"article_count"`
	UpdatedAt    time.Time `json:"updated_at"`
}

type companySource struct {
	ID         int64     `json:"id"`
	Kind       string    `json:"kind"`
	Label      string    `json:"label"`
	URL        string    `json:"url"`
	VerifiedAt time.Time `json:"verified_at"`
}

type companyInput struct {
	Slug        string   `json:"slug"`
	NameZh      string   `json:"name_zh"`
	NameEn      string   `json:"name_en"`
	Aliases     []string `json:"aliases"`
	Region      string   `json:"region"`
	Focus       string   `json:"focus"`
	Description string   `json:"description"`
	Website     string   `json:"website"`
	Active      bool     `json:"active"`
}

func validIntelligenceURL(raw string) bool {
	if raw == "" || len(raw) > 500 {
		return false
	}
	u, err := url.Parse(raw)
	return err == nil && (u.Scheme == "http" || u.Scheme == "https") && u.Hostname() != "" && u.User == nil
}

func readCompanyInput(c *gin.Context) (companyInput, bool) {
	var input companyInput
	if err := c.ShouldBindJSON(&input); err != nil {
		c.JSON(400, gin.H{"error": "invalid JSON"})
		return input, false
	}
	input.Slug = strings.TrimSpace(input.Slug)
	input.NameZh = strings.TrimSpace(input.NameZh)
	input.NameEn = strings.TrimSpace(input.NameEn)
	input.Region = strings.TrimSpace(input.Region)
	input.Focus = strings.TrimSpace(input.Focus)
	input.Description = strings.TrimSpace(input.Description)
	input.Website = strings.TrimSpace(input.Website)
	if len(input.Slug) > 80 || !companySlugPattern.MatchString(input.Slug) ||
		(input.NameZh == "" && input.NameEn == "") || len([]rune(input.NameZh)) > 120 ||
		len([]rune(input.NameEn)) > 120 || len([]rune(input.Region)) > 100 ||
		len([]rune(input.Focus)) > 200 || len([]rune(input.Description)) > 4000 ||
		(input.Website != "" && !validIntelligenceURL(input.Website)) || len(input.Aliases) > 12 {
		c.JSON(400, gin.H{"error": "invalid company fields"})
		return input, false
	}
	seen := make(map[string]bool)
	aliases := make([]string, 0, len(input.Aliases))
	for _, alias := range input.Aliases {
		alias = strings.TrimSpace(alias)
		key := strings.ToLower(alias)
		if alias == "" || len([]rune(alias)) > 80 {
			c.JSON(400, gin.H{"error": "invalid aliases"})
			return input, false
		}
		if !seen[key] {
			seen[key] = true
			aliases = append(aliases, alias)
		}
	}
	input.Aliases = aliases
	return input, true
}

const companyColumns = `c.id,c.slug,c.name_zh,c.name_en,c.aliases_json,c.region,c.focus,c.description,c.website,c.active,c.updated_at,(SELECT COUNT(*) FROM robot_articles a WHERE a.company_id=c.id AND a.published=1)`

type companyScanner interface{ Scan(...any) error }

func scanCompany(row companyScanner) (intelligenceCompany, error) {
	var company intelligenceCompany
	var aliases string
	var active int
	err := row.Scan(&company.ID, &company.Slug, &company.NameZh, &company.NameEn, &aliases,
		&company.Region, &company.Focus, &company.Description, &company.Website, &active,
		&company.UpdatedAt, &company.ArticleCount)
	if err != nil {
		return company, err
	}
	company.Active = active != 0
	company.Aliases = []string{}
	if aliases != "" {
		if err := json.Unmarshal([]byte(aliases), &company.Aliases); err != nil {
			return company, err
		}
	}
	return company, nil
}

func (h *CompanyHandler) List(c *gin.Context) {
	admin := strings.HasPrefix(c.FullPath(), "/api/admin/")
	limit, offset := 50, 0
	if raw := c.Query("limit"); raw != "" {
		n, err := strconv.Atoi(raw)
		if err != nil || n < 1 || n > 100 {
			c.JSON(400, gin.H{"error": "invalid limit"})
			return
		}
		limit = n
	}
	if raw := c.Query("offset"); raw != "" {
		n, err := strconv.Atoi(raw)
		if err != nil || n < 0 || n > 1000000 {
			c.JSON(400, gin.H{"error": "invalid offset"})
			return
		}
		offset = n
	}
	query := `SELECT ` + companyColumns + ` FROM intelligence_companies c WHERE 1=1`
	args := make([]any, 0, 5)
	if !admin {
		query += ` AND c.active=1`
	}
	if search := strings.TrimSpace(c.Query("search")); search != "" {
		if len([]rune(search)) > 100 {
			c.JSON(400, gin.H{"error": "search too long"})
			return
		}
		query += ` AND (c.name_zh LIKE ? OR c.name_en LIKE ? OR c.aliases_json LIKE ? OR c.focus LIKE ?)`
		pattern := "%" + search + "%"
		args = append(args, pattern, pattern, pattern, pattern)
	}
	query += ` ORDER BY c.active DESC,COALESCE(NULLIF(c.name_en,''),c.name_zh),c.id LIMIT ? OFFSET ?`
	args = append(args, limit+1, offset)
	rows, err := h.db.QueryContext(c.Request.Context(), query, args...)
	if err != nil {
		c.JSON(500, gin.H{"error": "database error"})
		return
	}
	defer rows.Close()
	companies := make([]intelligenceCompany, 0, limit)
	count := 0
	for rows.Next() {
		company, err := scanCompany(rows)
		if err != nil {
			c.JSON(500, gin.H{"error": "database error"})
			return
		}
		count++
		if count <= limit {
			companies = append(companies, company)
		}
	}
	if rows.Err() != nil {
		c.JSON(500, gin.H{"error": "database error"})
		return
	}
	c.JSON(200, gin.H{"companies": companies, "has_more": count > limit})
}

func (h *CompanyHandler) Get(c *gin.Context) {
	var company intelligenceCompany
	var err error
	if strings.HasPrefix(c.FullPath(), "/api/admin/") {
		id, parseErr := strconv.ParseInt(c.Param("id"), 10, 64)
		if parseErr != nil || id < 1 {
			c.Status(404)
			return
		}
		company, err = scanCompany(h.db.QueryRowContext(c.Request.Context(), `SELECT `+companyColumns+` FROM intelligence_companies c WHERE c.id=?`, id))
	} else {
		company, err = scanCompany(h.db.QueryRowContext(c.Request.Context(), `SELECT `+companyColumns+` FROM intelligence_companies c WHERE c.slug=? AND c.active=1`, c.Param("slug")))
	}
	if errors.Is(err, sql.ErrNoRows) {
		c.Status(404)
		return
	}
	if err != nil {
		c.JSON(500, gin.H{"error": "database error"})
		return
	}
	rows, err := h.db.QueryContext(c.Request.Context(), `SELECT id,kind,label,url,verified_at FROM intelligence_company_sources WHERE company_id=? ORDER BY kind,id`, company.ID)
	if err != nil {
		c.JSON(500, gin.H{"error": "database error"})
		return
	}
	defer rows.Close()
	sources := make([]companySource, 0)
	for rows.Next() {
		var source companySource
		if err := rows.Scan(&source.ID, &source.Kind, &source.Label, &source.URL, &source.VerifiedAt); err != nil {
			c.JSON(500, gin.H{"error": "database error"})
			return
		}
		sources = append(sources, source)
	}
	if rows.Err() != nil {
		c.JSON(500, gin.H{"error": "database error"})
		return
	}
	c.JSON(200, gin.H{"company": company, "sources": sources})
}

func (h *CompanyHandler) Create(c *gin.Context) {
	input, ok := readCompanyInput(c)
	if !ok {
		return
	}
	aliases, _ := json.Marshal(input.Aliases)
	result, err := h.db.ExecContext(c.Request.Context(), `INSERT INTO intelligence_companies(slug,name_zh,name_en,aliases_json,region,focus,description,website,active) VALUES(?,?,?,?,?,?,?,?,?)`,
		input.Slug, input.NameZh, input.NameEn, string(aliases), input.Region, input.Focus, input.Description, input.Website, input.Active)
	if err != nil {
		companyWriteError(c, err)
		return
	}
	id, _ := result.LastInsertId()
	c.JSON(http.StatusCreated, gin.H{"id": id})
}

func (h *CompanyHandler) Update(c *gin.Context) {
	id, err := strconv.ParseInt(c.Param("id"), 10, 64)
	if err != nil || id < 1 {
		c.Status(404)
		return
	}
	input, ok := readCompanyInput(c)
	if !ok {
		return
	}
	aliases, _ := json.Marshal(input.Aliases)
	result, err := h.db.ExecContext(c.Request.Context(), `UPDATE intelligence_companies SET name_zh=?,name_en=?,aliases_json=?,region=?,focus=?,description=?,website=?,active=? WHERE id=? AND slug=?`,
		input.NameZh, input.NameEn, string(aliases), input.Region, input.Focus, input.Description, input.Website, input.Active, id, input.Slug)
	if err != nil {
		companyWriteError(c, err)
		return
	}
	n, _ := result.RowsAffected()
	if n == 0 {
		var exists int
		if h.db.QueryRowContext(c.Request.Context(), `SELECT COUNT(*) FROM intelligence_companies WHERE id=? AND slug=?`, id, input.Slug).Scan(&exists) != nil || exists == 0 {
			c.Status(404)
			return
		}
	}
	c.Status(204)
}

func companyWriteError(c *gin.Context, err error) {
	var mysqlErr *mysql.MySQLError
	if errors.As(err, &mysqlErr) && mysqlErr.Number == 1062 {
		c.JSON(409, gin.H{"error": "duplicate company or source"})
		return
	}
	c.JSON(500, gin.H{"error": "database error"})
}

var sourceKinds = map[string]bool{"website": true, "blog": true, "github": true, "youtube": true, "social": true, "filing": true, "other": true}

func (h *CompanyHandler) AddSource(c *gin.Context) {
	id, err := strconv.ParseInt(c.Param("id"), 10, 64)
	if err != nil || id < 1 {
		c.Status(404)
		return
	}
	var input struct {
		Kind  string `json:"kind"`
		Label string `json:"label"`
		URL   string `json:"url"`
	}
	if err := c.ShouldBindJSON(&input); err != nil {
		c.JSON(400, gin.H{"error": "invalid JSON"})
		return
	}
	input.Kind = strings.TrimSpace(input.Kind)
	input.Label = strings.TrimSpace(input.Label)
	input.URL = strings.TrimSpace(input.URL)
	if !sourceKinds[input.Kind] || input.Label == "" || len([]rune(input.Label)) > 120 || !validIntelligenceURL(input.URL) {
		c.JSON(400, gin.H{"error": "invalid source fields"})
		return
	}
	var exists int
	if err := h.db.QueryRowContext(c.Request.Context(), `SELECT COUNT(*) FROM intelligence_companies WHERE id=?`, id).Scan(&exists); err != nil {
		c.JSON(500, gin.H{"error": "database error"})
		return
	}
	if exists == 0 {
		c.Status(404)
		return
	}
	hash := sha256.Sum256([]byte(input.URL))
	result, err := h.db.ExecContext(c.Request.Context(), `INSERT INTO intelligence_company_sources(company_id,kind,label,url,url_hash) VALUES(?,?,?,?,?)`, id, input.Kind, input.Label, input.URL, hex.EncodeToString(hash[:]))
	if err != nil {
		companyWriteError(c, err)
		return
	}
	sourceID, _ := result.LastInsertId()
	c.JSON(201, gin.H{"id": sourceID})
}

func (h *CompanyHandler) DeleteSource(c *gin.Context) {
	id, err := strconv.ParseInt(c.Param("id"), 10, 64)
	if err != nil || id < 1 {
		c.Status(404)
		return
	}
	sourceID, err := strconv.ParseInt(c.Param("sourceId"), 10, 64)
	if err != nil || sourceID < 1 {
		c.Status(404)
		return
	}
	result, err := h.db.ExecContext(c.Request.Context(), `DELETE FROM intelligence_company_sources WHERE id=? AND company_id=?`, sourceID, id)
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
