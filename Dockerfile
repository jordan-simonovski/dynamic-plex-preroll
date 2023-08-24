FROM golang:1.21

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

RUN CGO_CFLAGS_ALLOW='-Xpreprocessor' GOOS=linux GOARCH=$BUILDARCH \
	&& go mod download \
    && go build ./cmd/plex-pre-rolls

CMD ["./plex-pre-rolls"]