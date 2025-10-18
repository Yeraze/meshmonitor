.PHONY: build-arm64 build-amd64 build-multi push-multi run-pi

IMAGE ?= meshmonitor
TAG ?= local
REG ?= ghcr.io
OWNER ?= n30nex

build-arm64:
\tdocker buildx build --platform linux/arm64 -t $(IMAGE):arm64-$(TAG) --load --build-arg FETCH_PROTOBUF=1 .

build-amd64:
\tdocker buildx build --platform linux/amd64 -t $(IMAGE):amd64-$(TAG) --load --build-arg FETCH_PROTOBUF=1 .

build-multi:
\tdocker buildx build --platform linux/amd64,linux/arm64 -t $(REG)/$(OWNER)/$(IMAGE):$(TAG) --push --build-arg FETCH_PROTOBUF=1 .

push-multi: build-multi

run-pi:
\tdocker run --rm -it -p 8080:3001 -e SESSION_SECRET=dev_change_me -v meshmonitor-data:/data $(IMAGE):arm64-$(TAG)
