package sip

import (
	cryptorand "crypto/rand"
	"crypto/sha1"
	"encoding/binary"
	"encoding/hex"
	"fmt"
	"math/rand"
	"sync"
)

var (
	rngMu sync.Mutex
	rng   *rand.Rand
)

func init() {
	var buf [8]byte
	if _, err := cryptorand.Read(buf[:]); err != nil {
		panic("sip: failed to seed RNG: " + err.Error())
	}
	rng = rand.New(rand.NewSource(int64(binary.BigEndian.Uint64(buf[:]))))
}

// lockedRandIntn returns a random int in [0, n) using the package-level RNG.
func lockedRandIntn(n int) int {
	rngMu.Lock()
	defer rngMu.Unlock()
	return rng.Intn(n)
}

// randomNumber returns a random number with exactly the given number of
// decimal digits (e.g. digits=4 returns a value in [1000, 9999]).
func randomNumber(digits int) int {
	lo := 1
	for i := 1; i < digits; i++ {
		lo *= 10
	}
	hi := lo*10 - 1
	return lo + lockedRandIntn(hi-lo+1)
}

// CreateCallID returns a random 7-digit Call-ID string.
func CreateCallID() string {
	return fmt.Sprintf("%d", randomNumber(7))
}

// CreateFromTag returns a From-tag of the form "F" followed by a random
// 4-digit number.
func CreateFromTag() string {
	return fmt.Sprintf("F%d", randomNumber(4))
}

// CreateToTag returns a To-tag of the form "T" followed by a random
// 4-digit number.
func CreateToTag() string {
	return fmt.Sprintf("T%d", randomNumber(4))
}

// CreateBranchID returns a Via branch parameter with the RFC 3261 magic cookie
// followed by a random 6-digit number.
func CreateBranchID() string {
	return fmt.Sprintf("z9hG4bK%d", randomNumber(6))
}

// GenRSeq returns a random RSeq value in [1, 2^32-1].
func GenRSeq() uint32 {
	rngMu.Lock()
	defer rngMu.Unlock()
	return uint32(rng.Int63n(int64(^uint32(0)))) + 1
}

// GenCNonce returns a random 128-bit value encoded as a lowercase hex string,
// suitable for use as a Digest cnonce parameter.
func GenCNonce() string {
	var buf [16]byte
	rngMu.Lock()
	for i := range buf {
		buf[i] = byte(rng.Intn(256))
	}
	rngMu.Unlock()
	return hex.EncodeToString(buf[:])
}

// dnsNamespaceUUID is the UUID for the DNS namespace per RFC 4122 appendix C.
var dnsNamespaceUUID = [16]byte{
	0x6b, 0xa7, 0xb8, 0x10,
	0x9d, 0xad, 0x11, 0xd1,
	0x80, 0xb4, 0x00, 0xc0,
	0x4f, 0xd4, 0x30, 0xc8,
}

// InstanceUUID returns a deterministic UUID v5 (RFC 4122) for the given
// extension, using the DNS namespace and the name "{ext}.avaya.com". This
// mirrors the Python _instance_uuid function used in registration.
func InstanceUUID(ext string) string {
	h := sha1.New()
	h.Write(dnsNamespaceUUID[:])
	h.Write([]byte(ext + ".avaya.com"))
	sum := h.Sum(nil)

	var u [16]byte
	copy(u[:], sum[:16])
	u[6] = (u[6] & 0x0f) | 0x50 // version 5
	u[8] = (u[8] & 0x3f) | 0x80 // variant 10xx

	return fmt.Sprintf("%x-%x-%x-%x-%x",
		u[0:4], u[4:6], u[6:8], u[8:10], u[10:16])
}
