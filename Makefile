# Every target only delegates to scripts/<target>.sh. Do not add logic here.
TARGETS := contract test docs leak-check wasm-check abi-check secret-scan lint

.PHONY: $(TARGETS)

$(TARGETS):
	@scripts/$@.sh
