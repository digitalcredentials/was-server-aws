build-DCCSharedLayer:
	# 1. Install dependencies locally
	# For now leaving out beause it seems to work with the local node_modules
	# and the extra install was taking a fair bit of time
	# npm install 

	# 2. Create the nodejs directory required by Lambda
	mkdir -p "$(ARTIFACTS_DIR)/nodejs"

	# 3. Use esbuild to build the shared code as esm
	# the 'banner' option fixes errors with cjs 'require' statements in the esm build
	npx esbuild dcc-shared-layer-utils/index.mjs --bundle --minify --platform=node --format=esm --target=node24 --banner:js="import { createRequire } from 'module'; const require = createRequire(import.meta.url);" --outfile="$(ARTIFACTS_DIR)/nodejs/dcc-shared-layer-utils/index.js"

	# 4. Copy package.json and install
	cp package.json "$(ARTIFACTS_DIR)/nodejs/"
	cd "$(ARTIFACTS_DIR)/nodejs" && npm install --production
