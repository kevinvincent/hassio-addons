ARG BUILD_FROM
FROM $BUILD_FROM

ENV LANG C.UTF-8

RUN apk add --no-cache nodejs npm

# Copy files for add-on

COPY . /app
WORKDIR /app

RUN chmod a+x run.sh
RUN npm install

CMD [ "./run.sh" ]
