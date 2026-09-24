package handler

import (
	"html"
	"strings"

	xhtml "golang.org/x/net/html"
	"golang.org/x/net/html/atom"
)

// Article HTML is stored and displayed only after applying this small allowlist.
// Media URLs must point to files uploaded through this server.
func sanitizeRobotContent(input string) string {
	root := &xhtml.Node{Type: xhtml.ElementNode, DataAtom: atom.Div, Data: "div"}
	nodes, err := xhtml.ParseFragment(strings.NewReader(input), root)
	if err != nil {
		return html.EscapeString(input)
	}
	var out strings.Builder
	for _, node := range nodes {
		renderRobotNode(&out, node)
	}
	return out.String()
}

func renderRobotNode(out *strings.Builder, node *xhtml.Node) {
	if node.Type == xhtml.TextNode {
		out.WriteString(html.EscapeString(node.Data))
		return
	}
	if node.Type != xhtml.ElementNode {
		return
	}
	tag := strings.ToLower(node.Data)
	switch tag {
	case "script", "style", "iframe", "object", "svg", "math", "form":
		return
	}
	allowed := map[string]bool{"p": true, "div": true, "br": true, "strong": true, "b": true, "em": true, "i": true, "u": true, "s": true, "ul": true, "ol": true, "li": true, "blockquote": true, "h2": true, "h3": true, "a": true, "img": true, "video": true}
	if !allowed[tag] {
		for child := node.FirstChild; child != nil; child = child.NextSibling {
			renderRobotNode(out, child)
		}
		return
	}
	var src, href string
	for _, attr := range node.Attr {
		switch attr.Key {
		case "src":
			src = attr.Val
		case "href":
			href = attr.Val
		}
	}
	if tag == "img" || tag == "video" {
		if !validRobotMediaURL(src) {
			return
		}
		out.WriteString("<" + tag + ` src="` + html.EscapeString(src) + `"`)
		if tag == "video" {
			out.WriteString(" controls preload=\"metadata\"")
		}
		out.WriteString(">")
		if tag == "video" {
			out.WriteString("</video>")
		}
		return
	}
	out.WriteString("<" + tag)
	if tag == "a" && (strings.HasPrefix(href, "https://") || strings.HasPrefix(href, "http://")) {
		out.WriteString(` href="` + html.EscapeString(href) + `" target="_blank" rel="noopener noreferrer"`)
	}
	out.WriteString(">")
	if tag != "br" {
		for child := node.FirstChild; child != nil; child = child.NextSibling {
			renderRobotNode(out, child)
		}
		out.WriteString("</" + tag + ">")
	}
}
