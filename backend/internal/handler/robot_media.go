package handler

import (
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strings"

	"github.com/gin-gonic/gin"
)

const maxRobotMediaBytes = 50 << 20

var robotMediaName = regexp.MustCompile(`^[a-f0-9]{32}\.(jpg|png|gif|webp|mp4|webm)$`)

type RobotMediaHandler struct{ dir string }

func NewRobotMediaHandler(dir string) (*RobotMediaHandler, error) {
	if err := os.MkdirAll(dir, 0700); err != nil {
		return nil, err
	}
	return &RobotMediaHandler{dir: dir}, nil
}

func validRobotMediaURL(value string) bool {
	return strings.HasPrefix(value, "/api/robot/media/") && robotMediaName.MatchString(strings.TrimPrefix(value, "/api/robot/media/"))
}

func robotMediaType(header []byte) (string, string) {
	if len(header) >= 12 && string(header[4:8]) == "ftyp" {
		return "mp4", "video/mp4"
	}
	if len(header) >= 4 && string(header[:4]) == "\x1a\x45\xdf\xa3" {
		return "webm", "video/webm"
	}
	switch http.DetectContentType(header) {
	case "image/jpeg":
		return "jpg", "image/jpeg"
	case "image/png":
		return "png", "image/png"
	case "image/gif":
		return "gif", "image/gif"
	case "image/webp":
		return "webp", "image/webp"
	}
	return "", ""
}

func (h *RobotMediaHandler) Upload(c *gin.Context) {
	c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, maxRobotMediaBytes+1024*1024)
	file, header, err := c.Request.FormFile("file")
	if err != nil {
		c.JSON(400, gin.H{"error": "missing or oversized file"})
		return
	}
	defer file.Close()
	if header.Size < 1 || header.Size > maxRobotMediaBytes {
		c.JSON(400, gin.H{"error": "file too large"})
		return
	}
	peek := make([]byte, 512)
	n, err := io.ReadFull(file, peek)
	if err != nil && err != io.EOF && err != io.ErrUnexpectedEOF {
		c.Status(400)
		return
	}
	ext, mime := robotMediaType(peek[:n])
	if ext == "" {
		c.JSON(400, gin.H{"error": "unsupported media type"})
		return
	}
	if _, err := file.Seek(0, io.SeekStart); err != nil {
		c.Status(500)
		return
	}
	random := make([]byte, 16)
	if _, err := rand.Read(random); err != nil {
		c.Status(500)
		return
	}
	name := hex.EncodeToString(random) + "." + ext
	output, err := os.OpenFile(filepath.Join(h.dir, name), os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
	if err != nil {
		c.Status(500)
		return
	}
	written, copyErr := io.Copy(output, io.LimitReader(file, maxRobotMediaBytes+1))
	closeErr := output.Close()
	if copyErr != nil || closeErr != nil || written > maxRobotMediaBytes {
		os.Remove(filepath.Join(h.dir, name))
		c.Status(500)
		return
	}
	c.JSON(201, gin.H{"url": "/api/robot/media/" + name, "mime": mime})
}

func (h *RobotMediaHandler) Get(c *gin.Context) {
	name := c.Param("name")
	if !robotMediaName.MatchString(name) {
		c.Status(404)
		return
	}
	f, err := os.Open(filepath.Join(h.dir, name))
	if err != nil {
		c.Status(404)
		return
	}
	defer f.Close()
	info, err := f.Stat()
	if err != nil {
		c.Status(404)
		return
	}
	_, mime := robotMediaTypeFromExtension(filepath.Ext(name))
	c.Header("Content-Type", mime)
	c.Header("X-Content-Type-Options", "nosniff")
	c.Header("Cache-Control", "public, max-age=31536000, immutable")
	http.ServeContent(c.Writer, c.Request, fmt.Sprintf("%s", name), info.ModTime(), f)
}

func robotMediaTypeFromExtension(ext string) (string, string) {
	switch ext {
	case ".jpg":
		return "jpg", "image/jpeg"
	case ".png":
		return "png", "image/png"
	case ".gif":
		return "gif", "image/gif"
	case ".webp":
		return "webp", "image/webp"
	case ".mp4":
		return "mp4", "video/mp4"
	case ".webm":
		return "webm", "video/webm"
	}
	return "", "application/octet-stream"
}
