package com.nori.ai.integration.api;

import java.math.BigDecimal;
import java.math.BigInteger;
import java.time.Instant;
import java.util.ArrayList;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

public record AiToolItem(String ref, String text, Map<String, Object> values, Instant time) {
    public AiToolItem {
        values = values == null ? null : immutableObject(values);
    }

    static Map<String, Object> immutableObject(Map<String, ?> source) {
        Map<String, Object> copy = new LinkedHashMap<>();
        source.forEach((key, value) -> {
            if (key == null) throw new IllegalArgumentException("JSON 객체 키는 문자열이어야 합니다.");
            copy.put(key, immutableValue(value));
        });
        return Collections.unmodifiableMap(copy);
    }

    private static Object immutableValue(Object value) {
        if (value == null || value instanceof String || value instanceof Boolean
                || value instanceof Byte || value instanceof Short || value instanceof Integer
                || value instanceof Long || value instanceof BigInteger || value instanceof BigDecimal) {
            return value;
        }
        if (value instanceof Double number && Double.isFinite(number)) return value;
        if (value instanceof Float number && Float.isFinite(number)) return value;
        if (value instanceof Map<?, ?> object) {
            Map<String, Object> copy = new LinkedHashMap<>();
            object.forEach((key, item) -> {
                if (!(key instanceof String name)) {
                    throw new IllegalArgumentException("JSON 객체 키는 문자열이어야 합니다.");
                }
                copy.put(name, immutableValue(item));
            });
            return Collections.unmodifiableMap(copy);
        }
        if (value instanceof List<?> array) {
            List<Object> copy = new ArrayList<>(array.size());
            array.forEach(item -> copy.add(immutableValue(item)));
            return Collections.unmodifiableList(copy);
        }
        throw new IllegalArgumentException("JSON 값으로 지원하지 않는 자료형입니다.");
    }
}
