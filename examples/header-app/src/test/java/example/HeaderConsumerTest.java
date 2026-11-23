package example;

class HeaderConsumerTest extends ConsumerContract {
    @Override Class<?> application() { return HeaderExampleApplication.class; }
    @Override String systemId() { return "HeaderExample"; }
    @Override String issuer() { return "header-example"; }
    @Override boolean cookie() { return false; }
}
