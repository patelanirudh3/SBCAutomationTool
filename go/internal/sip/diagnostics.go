package sip

import "sync/atomic"

// ParserHealth is a snapshot of parser/framer diagnostics. Counters are
// process-lifetime values and are exposed through TrafficMetrics so high-volume
// runs can surface parser anomalies without scanning logs.
type ParserHealth struct {
	InvalidStartLine          uint64 `json:"invalid_start_line"`
	InvalidContentLength      uint64 `json:"invalid_content_length"`
	ConflictingContentLength  uint64 `json:"conflicting_content_length"`
	MalformedHeader           uint64 `json:"malformed_header"`
	FoldedHeaderWithoutParent uint64 `json:"folded_header_without_parent"`
}

var parserHealth struct {
	invalidStartLine          atomic.Uint64
	invalidContentLength      atomic.Uint64
	conflictingContentLength  atomic.Uint64
	malformedHeader           atomic.Uint64
	foldedHeaderWithoutParent atomic.Uint64
}

func recordInvalidStartLine() {
	parserHealth.invalidStartLine.Add(1)
}

func recordInvalidContentLength() {
	parserHealth.invalidContentLength.Add(1)
}

func recordConflictingContentLength() {
	parserHealth.conflictingContentLength.Add(1)
}

func recordMalformedHeader() {
	parserHealth.malformedHeader.Add(1)
}

func recordFoldedHeaderWithoutParent() {
	parserHealth.foldedHeaderWithoutParent.Add(1)
}

func ParserHealthSnapshot() ParserHealth {
	return ParserHealth{
		InvalidStartLine:          parserHealth.invalidStartLine.Load(),
		InvalidContentLength:      parserHealth.invalidContentLength.Load(),
		ConflictingContentLength:  parserHealth.conflictingContentLength.Load(),
		MalformedHeader:           parserHealth.malformedHeader.Load(),
		FoldedHeaderWithoutParent: parserHealth.foldedHeaderWithoutParent.Load(),
	}
}
