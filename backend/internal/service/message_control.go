package service

import "errors"

const MaxControlProofBytes = 16 * 1024

var ErrInvalidControlProof = errors.New("invalid control proof")

func controlProof(proofs []string) (string, error) {
	if len(proofs) == 0 {
		return "", nil
	}
	if len(proofs) != 1 || len(proofs[0]) > MaxControlProofBytes {
		return "", ErrInvalidControlProof
	}
	return proofs[0], nil
}

func ValidateReadProofs(ids []string, proofs map[string]string) error {
	if proofs == nil {
		return nil
	}
	expected := make(map[string]bool, len(ids))
	for _, id := range ids {
		expected[id] = true
	}
	if len(proofs) != len(expected) {
		return ErrInvalidControlProof
	}
	for id, proof := range proofs {
		if !expected[id] || len(proof) == 0 || len(proof) > MaxControlProofBytes {
			return ErrInvalidControlProof
		}
	}
	return nil
}
