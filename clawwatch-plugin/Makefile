.PHONY: build clean install dev

# Build the React dashboard and copy into the Python package
build:
	cd ../clawwatch-ui && npm ci && npm run build
	rm -rf clawwatch/static
	cp -r ../clawwatch-ui/dist clawwatch/static

# Install the Python package in editable mode
install:
	pip install -e .

# Build + install in one step
dev: build install

# Remove build artifacts
clean:
	rm -rf clawwatch/static
	rm -rf dist *.egg-info build
