package com.nori.ai.integration.web;

import com.nori.ai.integration.api.AiRequestIdentity;
import com.nori.ai.integration.observability.AiRequestLog;
import com.nori.ai.integration.security.AiIdentityService;
import com.nori.ai.integration.security.AiIdentityService.Failure;
import jakarta.servlet.AsyncContext;
import jakarta.servlet.AsyncEvent;
import jakarta.servlet.AsyncListener;
import jakarta.servlet.ServletOutputStream;
import jakarta.servlet.WriteListener;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import java.io.IOException;
import java.net.SocketTimeoutException;
import java.nio.charset.StandardCharsets;
import java.util.ArrayDeque;
import java.util.Arrays;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.RejectedExecutionException;
import java.util.concurrent.ScheduledFuture;
import java.util.concurrent.ScheduledThreadPoolExecutor;
import java.util.concurrent.SynchronousQueue;
import java.util.concurrent.ThreadPoolExecutor;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import org.apache.hc.client5.http.classic.methods.HttpUriRequestBase;

public final class AiSseRelay implements AutoCloseable {
    private static final int MAX_CONNECTIONS = 32;
    private static final int CHECK_SECONDS = 15;
    private static final int LIFETIME_SECONDS = 180;
    private static final int MAX_PENDING_BYTES = 65_536;
    private final AiGatewayRelay gateway;
    private final AiIdentityService identities;
    private final ScheduledThreadPoolExecutor timers;
    private final ThreadPoolExecutor readers;
    private final Set<Stream> active = ConcurrentHashMap.newKeySet();
    private final AtomicBoolean closed = new AtomicBoolean();

    public AiSseRelay(AiGatewayRelay gateway, AiIdentityService identities) {
        this(gateway, identities, new ScheduledThreadPoolExecutor(2,
                Thread.ofPlatform().daemon().name("nori-ai-sse-timer-", 0).factory()));
    }

    public AiSseRelay(AiGatewayRelay gateway, AiIdentityService identities, ScheduledThreadPoolExecutor timers) {
        this.gateway = gateway;
        this.identities = identities;
        this.timers = timers;
        this.timers.setRemoveOnCancelPolicy(true);
        readers = new ThreadPoolExecutor(0, MAX_CONNECTIONS, 30, TimeUnit.SECONDS, new SynchronousQueue<>(),
                Thread.ofPlatform().daemon().name("nori-ai-sse-reader-", 0).factory());
    }

    public void start(HttpServletRequest request, HttpServletResponse response, HttpUriRequestBase upstream,
            AiRequestIdentity identity, AiRequestLog log) throws IOException {
        if (closed.get()) throw new Failure(503, "GATEWAY_UNAVAILABLE", "connect");
        var stream = new Stream(request, response, upstream, identity, log);
        active.add(stream);
        stream.async.addListener(stream);
        stream.async.setTimeout(TimeUnit.SECONDS.toMillis(LIFETIME_SECONDS));
        try {
            stream.heartbeat = timers.scheduleAtFixedRate(stream::tick, CHECK_SECONDS, CHECK_SECONDS, TimeUnit.SECONDS);
            stream.deadline = timers.schedule(stream::close, LIFETIME_SECONDS, TimeUnit.SECONDS);
            readers.execute(stream::read);
        } catch (RejectedExecutionException exhausted) {
            log.error(response, new Failure(503, "GATEWAY_UNAVAILABLE", "connect"));
            stream.close();
        }
    }

    public int activeConnections() { return active.size(); }
    public int pendingTimers() { return timers.getQueue().size(); }

    private final class Stream implements AsyncListener, WriteListener {
        private final HttpServletRequest request;
        private final HttpServletResponse response;
        private final HttpUriRequestBase upstream;
        private final AiRequestIdentity initial;
        private final AiRequestLog log;
        private final AsyncContext async;
        private final ArrayDeque<byte[]> output = new ArrayDeque<>();
        private final AtomicBoolean ended = new AtomicBoolean();
        private final TerminalParser parser = new TerminalParser();
        private ServletOutputStream downstream;
        private volatile ScheduledFuture<?> heartbeat;
        private volatile ScheduledFuture<?> deadline;
        private int queued;
        private boolean draining;
        private boolean completing;
        private boolean containerError;

        Stream(HttpServletRequest request, HttpServletResponse response, HttpUriRequestBase upstream,
                AiRequestIdentity initial, AiRequestLog log) {
            this.request = request;
            this.response = response;
            this.upstream = upstream;
            this.initial = initial;
            this.log = log;
            async = request.startAsync(request, response);
        }

        void read() {
            try (var opened = gateway.open(upstream)) {
                synchronized (this) {
                    if (ended.get()) return;
                    gateway.copyHeaders(opened, response, log);
                    if (opened.getCode() >= 200 && opened.getCode() < 300) {
                        response.setHeader("X-Accel-Buffering", "no");
                        response.setHeader("Cache-Control", "no-cache");
                    }
                    downstream = response.getOutputStream();
                    downstream.setWriteListener(this);
                    response.flushBuffer();
                }
                if (opened.getCode() < 200 || opened.getCode() >= 300) {
                    byte[] body = opened.getEntity() == null ? new byte[0] : opened.getEntity().getContent().readAllBytes();
                    gateway.record(opened.getCode(), body, log);
                    enqueue(body);
                    finish();
                    return;
                }
                log.record("connect", opened.getCode(), null, null, null);
                if (opened.getEntity() != null) {
                    var input = opened.getEntity().getContent();
                    byte[] buffer = new byte[4096];
                    int count;
                    while (!ended.get() && (count = input.read(buffer)) != -1) {
                        int end = parser.accept(buffer, count);
                        enqueue(Arrays.copyOf(buffer, end));
                        if (parser.terminal) break;
                    }
                }
                finish();
            } catch (SocketTimeoutException timeout) {
                fail(new Failure(504, "GATEWAY_TIMEOUT", "connect"));
            } catch (IOException failure) {
                if (!ended.get()) fail(new Failure(503, "GATEWAY_UNAVAILABLE", "connect"));
            } catch (IllegalStateException failure) {
                if (!ended.get()) fail(new Failure(503, "GATEWAY_UNAVAILABLE", "relay"));
            }
        }

        synchronized void tick() {
            // 종료 뒤에는 컨테이너가 요청·응답 객체를 재사용하므로 신원 확인·기록·쓰기를 모두 잠금 안에서 종료 전에만 한다.
            if (ended.get()) return;
            try {
                if (!initial.equals(identities.current(request))) { close(); return; }
                if (downstream != null && !draining) enqueue(": keepalive\n\n".getBytes(StandardCharsets.US_ASCII));
            } catch (Failure failure) { log.record("identity", response.getStatus(), failure.code(), null, null); close(); }
            catch (IOException disconnected) { log.record("relay", response.getStatus(), "GATEWAY_UNAVAILABLE", null, null); close(); }
        }

        synchronized void enqueue(byte[] bytes) throws IOException {
            if (ended.get() || bytes.length == 0) return;
            // 느린 브라우저 하나가 연결·메모리를 무제한 점유하지 않게 한다.
            if (queued + bytes.length > MAX_PENDING_BYTES) { log.record("relay", response.getStatus(), "GATEWAY_UNAVAILABLE", null, null); close(); return; }
            output.add(bytes);
            queued += bytes.length;
            drain();
        }

        private void drain() throws IOException {
            while (!ended.get() && downstream != null && downstream.isReady() && !output.isEmpty()) {
                byte[] bytes = output.remove();
                queued -= bytes.length;
                downstream.write(bytes);
                downstream.flush();
            }
            if (draining && output.isEmpty()) close();
        }

        synchronized void finish() throws IOException { draining = true; drain(); }
        @Override public synchronized void onWritePossible() throws IOException { drain(); }
        @Override public void onError(Throwable failure) { close(); }

        synchronized void fail(Failure failure) {
            if (ended.get()) return;
            try { log.error(response, failure); }
            catch (IOException disconnected) { log.record("relay", response.getStatus(), failure.code(), null, null); }
            finally { close(); }
        }

        void close() {
            if (release()) complete();
        }

        /**
         * Tomcat은 AsyncListener.onError가 반환된 뒤 응용 스레드의 AsyncContext 사용을 IllegalStateException으로 거부한다.
         * 이 리스너는 startAsync 직후 첫 번째로 등록되어 onError가 가장 먼저 호출되므로, 같은 잠금으로 onError 진입 전에만 여기서 끝내고
         * 그 뒤의 종료는 onError(컨테이너 스레드)가 맡는다.
         */
        private synchronized void complete() {
            if (completing || containerError) return;
            completing = true;
            async.complete();
        }

        boolean release() {
            int status;
            synchronized (this) {
                // 종료와 쓰기를 같은 잠금으로 직렬화하여 종료 뒤 새 쓰기를 막는다.
                if (!ended.compareAndSet(false, true)) return false;
                output.clear();
                queued = 0;
                // 잠금을 놓으면 컨테이너가 complete 후 응답을 재사용할 수 있으므로 기록할 상태 코드는 여기서 읽는다.
                status = response.getStatus();
            }
            try {
                var tick = heartbeat;
                var expiry = deadline;
                if (tick != null) tick.cancel(false);
                if (expiry != null) expiry.cancel(false);
                // 상류 응답 본문은 스레드 안전하지 않으므로 읽기 스레드만 닫는다(read의 try-with-resources).
                // 다른 스레드는 교환을 취소해 진행 중인 읽기를 끝내기만 한다.
                upstream.cancel();
            } finally {
                // ended가 true가 되면 다시 정리할 기회가 없으므로 정리 단계가 실패해도 연결 자리는 반드시 반납한다.
                active.remove(this);
            }
            log.record("relay", status, null, null, null);
            return true;
        }
        @Override public void onComplete(AsyncEvent event) { release(); }
        @Override public void onTimeout(AsyncEvent event) { close(); }
        @Override public void onError(AsyncEvent event) {
            synchronized (this) { containerError = true; }
            release();
            synchronized (this) {
                // 브라우저 쓰기 실패처럼 응용 스레드가 먼저 종료를 시작했어도 아직 complete하지 않았으면 컨테이너 스레드가 끝낸다.
                if (completing) return;
                completing = true;
            }
            async.complete();
        }
        @Override public void onStartAsync(AsyncEvent event) { event.getAsyncContext().addListener(this); }
    }

    private static final class TerminalParser {
        private final StringBuilder line = new StringBuilder();
        private String event = "";
        private boolean longLine;
        private boolean terminal;
        int accept(byte[] bytes, int length) {
            for (int index = 0; index < length; index++) {
                int value = bytes[index] & 0xff;
                if (value == '\r') continue;
                if (value == '\n') {
                    if (line.isEmpty() && !longLine) {
                        terminal = Set.of("job.completed", "job.partial", "job.failed", "job.cancelled").contains(event);
                        event = "";
                        if (terminal) return index + 1;
                    } else if (!longLine && line.toString().startsWith("event:")) event = line.substring(6).strip();
                    line.setLength(0);
                    longLine = false;
                } else if (line.length() < 128) line.append((char) value);
                else longLine = true;
            }
            return length;
        }
    }

    @Override public void close() {
        closed.set(true);
        active.forEach(Stream::close);
        timers.shutdownNow();
        readers.shutdownNow();
        try {
            if (!timers.awaitTermination(5, TimeUnit.SECONDS) || !readers.awaitTermination(5, TimeUnit.SECONDS)) {
                throw new IllegalStateException("AI 스트림 실행 자원이 종료되지 않았습니다.");
            }
        } catch (InterruptedException interrupted) {
            Thread.currentThread().interrupt();
            throw new IllegalStateException("AI 스트림 실행 자원 종료가 중단되었습니다.");
        }
    }
}
