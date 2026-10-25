# ---------- Stage 1: build Pulse 4.4 from source (1-2 h the first time) ----------
FROM debian:bookworm AS build
ARG PULSE_TAG=REL_4_4_0
ARG MAKE_JOBS=2
RUN apt-get update && apt-get install -y --no-install-recommends \
      git build-essential ca-certificates wget python3 python3-dev python3-venv default-jdk-headless \
    && rm -rf /var/lib/apt/lists/*
RUN python3 -m venv /opt/venv
ENV PATH="/opt/venv/bin:$PATH" JAVA_HOME=/usr/lib/jvm/default-java
RUN pip install --no-cache-dir "cmake>=3.31" numpy pandas scipy matplotlib openpyxl formulas plottable dataframe_image
RUN git clone --depth 1 --branch ${PULSE_TAG} https://gitlab.kitware.com/physiology/engine.git /source
RUN mkdir /build && cd /build && \
    cmake -DCMAKE_INSTALL_PREFIX=/pulse -DCMAKE_BUILD_TYPE:STRING=Release /source && \
    make -j${MAKE_JOBS} && rm -rf /build /source

# ---------- Stage 2: runtime ----------
FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends python3 ca-certificates libgomp1 \
    && rm -rf /var/lib/apt/lists/*
COPY --from=build /opt/venv /opt/venv
COPY --from=build /pulse /pulse
ENV PATH="/opt/venv/bin:$PATH" PYTHONPATH="/pulse/bin:/pulse/python:/app/bridge" PULSE_BIN=/pulse/bin WEB_DIR=/app/web
COPY bridge/requirements.txt /app/bridge/requirements.txt
RUN pip install --no-cache-dir -r /app/bridge/requirements.txt
COPY bridge /app/bridge
COPY web /app/web
# Bake condition-based case states (sepsis) into the image: a few CPU minutes, once.
RUN cd /pulse/bin && python /app/bridge/make_states.py
WORKDIR /pulse/bin
EXPOSE 8000
CMD ["uvicorn", "server:app", "--host", "0.0.0.0", "--port", "8000", "--app-dir", "/app/bridge", "--ws-ping-interval", "20"]
