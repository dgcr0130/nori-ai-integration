package example;

class CookieConsumerTest extends ConsumerContract {
    @Override Class<?> application() { return CookieExampleApplication.class; }
    @Override String systemId() { return "CookieExample"; }
    @Override String issuer() { return "cookie-example"; }
    @Override boolean cookie() { return true; }
}
