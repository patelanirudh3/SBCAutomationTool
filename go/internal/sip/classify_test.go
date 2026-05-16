package sip

import "testing"

func TestClassify401ByCSeqMethod(t *testing.T) {
	tests := []struct {
		name string
		raw  string
		want string
	}{
		{
			name: "invite",
			raw:  "SIP/2.0 401 Unauthorized\r\nCSeq: 1 INVITE\r\nContent-Length: 0\r\n\r\n",
			want: "401_INVITE",
		},
		{
			name: "prack",
			raw:  "SIP/2.0 401 Unauthorized\r\nCSeq: 2 PRACK\r\nContent-Length: 0\r\n\r\n",
			want: "401_PRACK",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, _ := ClassifyMessage(tt.raw)
			if got != tt.want {
				t.Fatalf("ClassifyMessage() = %q, want %q", got, tt.want)
			}
		})
	}
}

func TestPrackFinalFailureRemainsBareStatusWithCSeqMethod(t *testing.T) {
	raw := "SIP/2.0 480 Temporarily Unavailable\r\nCSeq: 2 PRACK\r\nContent-Length: 0\r\n\r\n"

	got, _ := ClassifyMessage(raw)
	if got != "480" {
		t.Fatalf("ClassifyMessage() = %q, want 480", got)
	}
}
