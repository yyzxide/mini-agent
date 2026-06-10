package com.yuzhe.codeagent;

import com.yuzhe.codeagent.config.CodeAgentProperties;
import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;
import org.springframework.boot.context.properties.EnableConfigurationProperties;

@SpringBootApplication
@EnableConfigurationProperties(CodeAgentProperties.class)
public class CodeAgentBackendApplication {

    public static void main(String[] args) {
        SpringApplication.run(CodeAgentBackendApplication.class, args);
    }
}
