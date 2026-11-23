package com.nori.ai.integration.tool;

import com.nori.ai.integration.api.AiToolCall;
import com.nori.ai.integration.api.AiToolHandler;
import com.nori.ai.integration.api.AiToolResult;
import com.nori.ai.integration.security.AiIdentityService.Failure;
import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.Future;
import java.util.concurrent.RejectedExecutionException;
import java.util.concurrent.SynchronousQueue;
import java.util.concurrent.ThreadPoolExecutor;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;
import java.util.function.Function;

/** 대기열 없이 실행 슬롯만 허용하며 취소를 무시하는 처리기도 슬롯을 계속 점유한다. */
public final class AiToolDispatcher implements AutoCloseable {
    public static final int MAX_CONCURRENT = 8;
    private final ThreadPoolExecutor executor;
    private final Clock clock;
    public AiToolDispatcher(Clock clock) {
        this.clock = clock;
        executor = new ThreadPoolExecutor(MAX_CONCURRENT, MAX_CONCURRENT, 30, TimeUnit.SECONDS,
                new SynchronousQueue<>(), Thread.ofPlatform().name("nori-ai-tool-", 0).factory(), new ThreadPoolExecutor.AbortPolicy());
        executor.allowCoreThreadTimeOut(true);
    }
    public record Completed(AiToolResult result, Instant observedAt) {}
    public Completed execute(AiToolHandler handler, Instant deadline, Function<Instant, AiToolCall> call) {
        final Future<Completed> future;
        try {
            future = executor.submit(() -> {
                Instant observed = clock.instant();
                if (!observed.isBefore(deadline)) throw new Expired();
                return new Completed(handler.handle(call.apply(observed)), observed);
            });
        } catch (RejectedExecutionException busy) { throw new Failure(429, "SOURCE_BUSY", "handler"); }
        try {
            Duration remaining = Duration.between(clock.instant(), deadline);
            if (remaining.isNegative() || remaining.isZero()) throw new Failure(504, "TIMEOUT", "handler");
            Completed result = future.get(remaining.toNanos(), TimeUnit.NANOSECONDS);
            if (!clock.instant().isBefore(deadline)) throw new Failure(504, "TIMEOUT", "handler");
            return result;
        } catch (TimeoutException timeout) { throw new Failure(504, "TIMEOUT", "handler"); }
        catch (InterruptedException interrupted) { Thread.currentThread().interrupt(); throw new Failure(504, "TIMEOUT", "handler"); }
        catch (ExecutionException failed) {
            if (failed.getCause() instanceof Expired) throw new Failure(504, "TIMEOUT", "handler");
            throw new Failure(503, "SOURCE_UNAVAILABLE", "handler");
        } finally { future.cancel(true); }
    }
    private static final class Expired extends RuntimeException {
        private static final long serialVersionUID = 1L;
    }
    public int activeCount() { return executor.getActiveCount(); }
    @Override public void close() { executor.shutdownNow(); executor.close(); }
}
