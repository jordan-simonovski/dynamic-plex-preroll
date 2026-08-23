# ---- plex-token: tiny helper to mint a Plex auth token ------------------------
# Pure-Go HTTP client; no ImageMagick/ffmpeg, so this stays small and fast.
FROM golang:1.26 AS plex-token

WORKDIR /build
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN go build -o /usr/local/bin/plex-token ./cmd/plex-token

ENTRYPOINT ["plex-token"]

# ---- plex-pre-rolls: full render toolchain (ImageMagick + ffmpeg) -------------
FROM golang:1.26 AS plex-pre-rolls

# Ignore APT warnings about not having a TTY
ENV DEBIAN_FRONTEND noninteractive

# install build essentials
RUN apt-get update && \
    apt-get install -y wget build-essential pkg-config --no-install-recommends

# Install ImageMagick and ffmpeg deps
RUN apt-get -q -y install libjpeg-dev libpng-dev libtiff-dev ffmpeg \
	libpq-dev libmagick++-dev fonts-liberation sox bc xvfb xdg-utils \
    libgif-dev libx11-dev --no-install-recommends

ENV IMAGEMAGICK_VERSION=6.9.10-11

RUN cd && \
	wget https://github.com/ImageMagick/ImageMagick6/archive/${IMAGEMAGICK_VERSION}.tar.gz && \
	tar xvzf ${IMAGEMAGICK_VERSION}.tar.gz && \
	cd ImageMagick* && \
	./configure \
	    --without-magick-plus-plus \
	    --without-perl \
	    --disable-openmp \
	    --with-gvc=no \
	    --disable-docs && \
	make -j$(nproc) && make install && \
	ldconfig /usr/local/lib

WORKDIR /build
COPY . .

# Two binaries out of one stage. plex-pre-rolls needs CGO for ImageMagick;
# preroll-ui is built CGO-free on purpose — it never links the renderer, it
# executes it, which is why one image can serve both roles.
RUN CGO_CFLAGS_ALLOW='-Xpreprocessor' GOOS=linux GOARCH=$BUILDARCH \
	&& go mod download \
	&& go build -o /usr/local/bin/plex-pre-rolls ./cmd/plex-pre-rolls \
	&& CGO_ENABLED=0 go build -o /usr/local/bin/preroll-ui ./cmd/preroll-ui

CMD ["plex-pre-rolls"]
