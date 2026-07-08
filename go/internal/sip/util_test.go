package sip

import (
	"regexp"
	"strings"
	"testing"
)

func TestCreateCallIDUsesUUIDStyleAndDomain(t *testing.T) {
	callID := CreateCallID()
	if callID == "" {
		t.Fatal("CreateCallID returned empty value")
	}
	re := regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}@nexus-traffic-engine$`)
	if !re.MatchString(callID) {
		t.Fatalf("CreateCallID=%q, want UUID v4@nexus-traffic-engine", callID)
	}
}

func TestCreateBranchIDUsesRFC3261CookieAndStrongSuffix(t *testing.T) {
	branch := CreateBranchID()
	if branch == "" {
		t.Fatal("CreateBranchID returned empty value")
	}
	if !strings.HasPrefix(branch, "z9hG4bK") {
		t.Fatalf("CreateBranchID=%q missing RFC 3261 magic cookie", branch)
	}
	re := regexp.MustCompile(`^z9hG4bK[0-9a-f]{32}$`)
	if !re.MatchString(branch) {
		t.Fatalf("CreateBranchID=%q, want z9hG4bK plus 128-bit hex suffix", branch)
	}
}

func TestCreateCallIDAndBranchAreUniqueAcrossSample(t *testing.T) {
	const n = 10000
	callIDs := make(map[string]struct{}, n)
	branches := make(map[string]struct{}, n)
	for i := 0; i < n; i++ {
		callID := CreateCallID()
		if _, ok := callIDs[callID]; ok {
			t.Fatalf("duplicate Call-ID generated: %s", callID)
		}
		callIDs[callID] = struct{}{}

		branch := CreateBranchID()
		if _, ok := branches[branch]; ok {
			t.Fatalf("duplicate branch generated: %s", branch)
		}
		branches[branch] = struct{}{}
	}
}

func TestFallbackIDsAreNonEmpty(t *testing.T) {
	if got := fallbackCallID(); got == "" {
		t.Fatal("fallbackCallID returned empty value")
	}
	branch := fallbackBranchID()
	if branch == "" {
		t.Fatal("fallbackBranchID returned empty value")
	}
	if !strings.HasPrefix(branch, "z9hG4bK") {
		t.Fatalf("fallbackBranchID=%q missing RFC 3261 magic cookie", branch)
	}
}
