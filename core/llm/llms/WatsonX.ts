import {
  ChatMessage,
  CompletionOptions,
  LLMOptions,
  ModelProvider,
} from "../../index.js";
import { stripImages } from "../images.js";
import { BaseLLM } from "../index.js";
import { streamResponse } from "../stream.js";
const watsonxConfig = {
  accessToken: {
    expiration: 0,
    token: "",
  },
};
class WatsonX extends BaseLLM {
  maxStopWords: number | undefined = undefined;

  constructor(options: LLMOptions) {
    super(options);
  }
  async getBearerToken(): Promise<{ token: string; expiration: number }> {
    
    if (
      this.watsonxUrl?.includes("cloud.ibm.com")
    ) {
      // watsonx SaaS
      const wxToken = await (
        await fetch(
          `https://iam.cloud.ibm.com/identity/token?apikey=${this.watsonxCreds}&grant_type=urn:ibm:params:oauth:grant-type:apikey`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/x-www-form-urlencoded",
              Accept: "application/json",
            },
          },
        )
      ).json();
      return {
        token: wxToken["access_token"],
        expiration: wxToken["expiration"],
      };
    }

    // Using ZenApiKey auth
    return {
      token: this.watsonxCreds ?? "",
      expiration: -1,
    };
  }

  static providerName: ModelProvider = "watsonx";

  protected _convertMessage(message: ChatMessage) {
    if (typeof message.content === "string") {
      return message;
    }

    const parts = message.content.map((part) => {
      const msg: any = {
        type: part.type,
        text: part.text,
      };
      if (part.type === "imageUrl") {
        msg.image_url = { ...part.imageUrl, detail: "low" };
        msg.type = "image_url";
      }
      return msg;
    });
    return {
      ...message,
      content: parts,
    };
  }

  protected _convertModelName(model: string): string {
    return model;
  }

  protected _convertArgs(options: any, messages: ChatMessage[]) {
    const finalOptions = {
      messages: messages.map(this._convertMessage),
      model: this._convertModelName(options.model),
      max_tokens: options.maxTokens,
      temperature: options.temperature,
      top_p: options.topP,
      frequency_penalty: options.frequencyPenalty,
      presence_penalty: options.presencePenalty,
    };
    return finalOptions;
  }

  protected _getHeaders() {
    return {
      "Content-Type": "application/json",
      Authorization: `${
        watsonxConfig.accessToken.expiration === -1 ? "ZenApiKey" : "Bearer"
      } ${watsonxConfig.accessToken.token}`,
    };
  }

  protected async _complete(
    prompt: string,
    options: CompletionOptions,
  ): Promise<string> {
    let completion = "";
    for await (const chunk of this._streamChat(
      [{ role: "user", content: prompt }],
      options,
    )) {
      completion += chunk.content;
    }

    return completion;
  }

  protected async *_streamComplete(
    prompt: string,
    options: CompletionOptions,
  ): AsyncGenerator<string> {
    for await (const chunk of this._streamChat(
      [{ role: "user", content: prompt }],
      options,
    )) {
      yield stripImages(chunk.content);
    }
  }

  protected async *_streamChat(
    messages: ChatMessage[],
    options: CompletionOptions,
  ): AsyncGenerator<ChatMessage> {
    var now = new Date().getTime() / 1000;
    if (
      watsonxConfig.accessToken === undefined ||
      now > watsonxConfig.accessToken.expiration ||
      watsonxConfig.accessToken.token === undefined
    ) {
      watsonxConfig.accessToken = await this.getBearerToken();
    } else {
      console.log(
        `Reusing token (expires in ${
          (watsonxConfig.accessToken.expiration - now) / 60
        } mins)`,
      );
    }
    if (watsonxConfig.accessToken.token === undefined) {
      throw new Error("Something went wrong. Check your credentials, please.");
    }

    const stopToken =
      this.watsonxStopToken ??
      (options.model?.includes("granite") ? "<|im_end|>" : undefined);
    var response = await this.fetch(
      `${this.watsonxUrl}/ml/v1/text/generation_stream?version=${this.watsonxApiVersion}`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `${
            watsonxConfig.accessToken.expiration === -1 ? "ZenApiKey" : "Bearer"
          } ${watsonxConfig.accessToken.token}`,
        },
        body: JSON.stringify({
          input: messages[messages.length - 1].content,
          parameters: {
            decoding_method: "greedy",
            max_new_tokens: options.maxTokens ?? 1024,
            min_new_tokens: 1,
            stop_sequences: stopToken ? [stopToken] : [],
            include_stop_sequence: false,
            repetition_penalty: 1,
          },
          model_id: options.model,
          project_id: this.watsonxProjectId
        }),
      },
    );

    if (!response.ok || response.body === null) {
      throw new Error(
        "Something went wrong. No response received, check your connection",
      );
    } else {
      for await (const value of streamResponse(response)) {

        const lines = value.split("\n");
        let generatedChunk = "";
        let generatedTextIndex = undefined;
        lines.forEach((el: string) => {
          // console.log(`${el}`);
          if (el.startsWith("id:")) {
            generatedTextIndex = parseInt(el.replace(/^id:\s+/, ""));
            if (isNaN(generatedTextIndex)) {
              console.error(`Unable to parse stream chunk ID: ${el}`);
            }
          } else if (el.startsWith("data:")) {
            const dataStr = el.replace(/^data:\s+/, "");
            try {
              const data = JSON.parse(dataStr);
              data.results.forEach((result: any) => {
                generatedChunk += result.generated_text || "";
              });
            } catch (e) {
              console.error(`Error parsing JSON string: ${dataStr}`, e);
            }
          }
        });
        yield {
          role: "assistant",
          content: generatedChunk,
        };
      }
    }
  }
}

export default WatsonX;
