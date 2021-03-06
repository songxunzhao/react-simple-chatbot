import React, { Component } from 'react';
import PropTypes from 'prop-types';
import deepEqual from 'deep-equal';
import { uuid } from 'uuidv4';
import { CustomStep, OptionsStep, TextStep, TextLoadingStep } from './steps_components';
import schema from './schemas/schema';
import * as storage from './storage';

import {
  ChatBotContainer,
  Content,
  Header,
  HeaderTitle,
  HeaderIcon,
  FloatButton,
  FloatingIcon,
  Footer,
  Input,
  SubmitButton
} from './components';
import Recognition from './recognition';
import { ChatIcon, CloseIcon, SubmitIcon, MicIcon } from './icons';
import {
  isMobile,
  isNestedVariable,
  splitByFirstPeriod,
  insertIntoObjectByPath,
  isVariable,
  makeVariable,
  deepCopy,
  getStepsFromBackend,
  sleep
} from './utils';
import { speakFn } from './speechSynthesis';
import MultipleChoiceStep from './steps_components/multiple_choice/MultipleChoiceStep';

class ChatBot extends Component {
  /* istanbul ignore next */
  constructor(props) {
    super(props);

    this.content = null;
    this.input = null;

    this.supportsScrollBehavior = false;

    this.setContentRef = element => {
      this.content = element;
    };

    this.setInputRef = element => {
      this.input = element;
    };

    this.state = {
      renderedSteps: [],
      currentStep: {},
      previousStep: {},
      steps: {},
      error: false,
      disabled: true,
      opened: props.opened || !props.floating,
      inputValue: '',
      inputInvalid: false,
      speaking: false,
      isStepFetchingInProgress: false,
      recognitionEnable: props.recognitionEnable && Recognition.isSupported(),
      sessionId: uuid(),
      partialDelayedInMilliseconds: 0
    };
    this.speak = speakFn(props.speechSynthesis);
  }

  async componentDidMount() {
    const { nextStepUrl, parseStep } = this.props;
    let { steps } = this.props;
    steps = steps || [];
    const { cache, cacheName, enableMobileAutoFocus } = this.props;
    const chatSteps = {};

    const focusInput = () => {
      // focus input if last step cached is a user step
      this.setState({ disabled: false }, () => {
        if (enableMobileAutoFocus || !isMobile()) {
          if (this.input) {
            this.input.focus();
          }
        }
      });
    };

    if (nextStepUrl && steps.length === 0) {
      let renderedSteps = [];
      let currentStep = null;
      let previousStep = null;

      const { botDelay, customDelay, readOnly } = this.props;

      this.setState({ isStepFetchingInProgress: true });
      const startTime = Date.now();
      const { sessionId } = this.state;

      steps = await getStepsFromBackend(nextStepUrl, undefined, undefined, sessionId, readOnly);
      if (steps.length === 0) {
        this.setState(() => {
          throw Error('Error: Could not find any steps');
        });
        return;
      }
      const firstStep = steps[0];

      const timeDuration = Date.now() - startTime;
      if (firstStep.message) {
        await sleep(Math.max(botDelay - timeDuration, 0));
      } else if (firstStep.component) {
        await sleep(Math.max(customDelay - timeDuration, 0));
      }
      this.setState({ isStepFetchingInProgress: false });

      // TODO: Delete after state backend is finished
      for (const step of steps) {
        chatSteps[step.id] = this.assignDefaultSetting(schema.parse(step));
      }

      if (steps.length === 0) {
        this.setState(() => {
          throw new Error('Steps not found');
        });
      }

      renderedSteps = this.parseRenderedSteps(steps.map(step => this.assignDefaultSetting(step)));
      renderedSteps[0].animated = false;
      const renderedNum = renderedSteps.length;
      currentStep = renderedSteps[renderedNum - 1];
      previousStep = renderedSteps.length > 1 ? renderedSteps[renderedNum - 2] : null;

      if (currentStep.message) {
        const { message } = currentStep;
        currentStep.message = typeof message === 'function' ? message() : message;
        chatSteps[currentStep.id].message = currentStep.message;
      }

      const waitingForUserInput = currentStep.user && !currentStep.value;

      if (waitingForUserInput) {
        renderedSteps.pop();
        focusInput();
      }

      this.setState({
        currentStep,
        previousStep,
        renderedSteps,
        steps: chatSteps
      });
    } else {
      for (let i = 0, len = steps.length; i < len; i += 1) {
        const step = parseStep ? parseStep(steps[i]) : steps[i];
        if (chatSteps[step.id]) {
          this.setState(() => {
            throw new Error(`There are duplicate steps: id=${step.id}`);
          });
        }
        chatSteps[step.id] = this.assignDefaultSetting(schema.parse(step));
      }
      schema.checkInvalidIds(chatSteps);

      const firstStep = steps[0];
      if (firstStep.message) {
        const { message } = firstStep;
        firstStep.message = typeof message === 'function' ? message() : message;
        chatSteps[firstStep.id].message = firstStep.message;
      }

      const { currentStep, previousStep, renderedSteps } = await storage.getData(
        {
          cacheName,
          cache,
          firstStep,
          steps: chatSteps,
          assignDefaultSetting: this.assignDefaultSetting
        },
        focusInput
      );

      this.setState({
        currentStep,
        previousStep,
        renderedSteps,
        steps: chatSteps
      });
    }

    const { recognitionEnable } = this.state;
    const { recognitionLang } = this.props;

    if (recognitionEnable) {
      this.recognition = new Recognition(
        this.onRecognitionChange,
        this.onRecognitionEnd,
        this.onRecognitionStop,
        recognitionLang
      );
    }

    this.supportsScrollBehavior = 'scrollBehavior' in document.documentElement.style;

    if (this.content) {
      this.content.addEventListener('DOMNodeInserted', this.onNodeInserted);
      window.addEventListener('resize', this.onResize);
    }
  }

  static getDerivedStateFromProps(props, state) {
    const { opened, toggleFloating } = props;
    if (toggleFloating !== undefined && opened !== undefined && opened !== state.opened) {
      return {
        ...state,
        opened
      };
    }
    return state;
  }

  componentWillUnmount() {
    if (this.content) {
      this.content.removeEventListener('DOMNodeInserted', this.onNodeInserted);
      window.removeEventListener('resize', this.onResize);
    }
  }

  parseRenderedSteps = renderedSteps => {
    return renderedSteps.map((renderedStep, index) => {
      const isLastRenderedSteps = index === renderedSteps.length - 1;
      const isWaitingForUserInput = renderedStep.user && !renderedStep.value;

      if (isLastRenderedSteps && !isWaitingForUserInput) {
        return {
          ...renderedStep,
          delay: 0
        };
      }

      if (isLastRenderedSteps && isWaitingForUserInput) {
        const { parseStep } = this.props;
        const userStep = renderedStep;
        const completeUserStep = parseStep ? parseStep(userStep) : userStep;
        return {
          ...completeUserStep,
          delay: 0
        };
      }

      return {
        ...renderedStep,
        delay: 0,
        rendered: true
      };
    });
  };

  getDefaultSettings = () => {
    const { botDelay, botAvatar, userDelay, userAvatar, customDelay } = this.props;

    const defaultBotSettings = { delay: botDelay, avatar: botAvatar };
    const defaultUserSettings = {
      delay: userDelay,
      avatar: userAvatar,
      hideInput: false,
      hideExtraControl: false
    };
    const defaultCustomSettings = { delay: customDelay };

    return { defaultBotSettings, defaultUserSettings, defaultCustomSettings };
  };

  onNodeInserted = event => {
    const { currentTarget: target } = event;
    const { enableSmoothScroll } = this.props;

    if (enableSmoothScroll && this.supportsScrollBehavior) {
      target.scroll({
        top: target.scrollHeight,
        left: 0,
        behavior: 'smooth'
      });
    } else {
      target.scrollTop = target.scrollHeight;
    }
  };

  onResize = () => {
    this.content.scrollTop = this.content.scrollHeight;
  };

  onRecognitionChange = value => {
    this.setState({ inputValue: value });
  };

  onRecognitionEnd = () => {
    this.setState({ speaking: false });
    this.handleSubmitButton();
  };

  onRecognitionStop = () => {
    this.setState({ speaking: false });
  };

  onValueChange = event => {
    this.setState({ inputValue: event.target.value });
  };

  saveStepValue = async (stepId, value, label) => {
    if (value == null) {
      this.setState(() => {
        throw new Error('Value is required parameter');
      });
    }

    const { renderedSteps, currentStep } = this.state;
    const lastStep = renderedSteps[renderedSteps.length - 1];
    if (label) {
      if (!currentStep.user) renderedSteps.pop();
      renderedSteps.push(this.assignDefaultSetting({ message: label, user: true, rendered: true }));
      this.setState({ renderedSteps, isStepFetchingInProgress: true });
    }

    const startTime = Date.now();
    const resultSteps = await this.getStepsFromApi(stepId, value);
    const partialDelayedInMilliseconds = Date.now() - startTime;
    this.setState({ partialDelayedInMilliseconds });

    if (label) {
      renderedSteps.pop();
      if (!currentStep.user) renderedSteps.push(lastStep);
      this.setState({ renderedSteps, isStepFetchingInProgress: false });
    }

    return resultSteps[0];
  };

  getTriggeredStep = (trigger, value) => {
    const steps = this.generateRenderedStepsById();
    return typeof trigger === 'function' ? trigger({ value, steps }) : trigger;
  };

  getStepMessage = message => {
    const { renderedSteps } = this.state;
    const lastStepIndex = renderedSteps.length > 0 ? renderedSteps.length - 1 : 0;
    const steps = this.generateRenderedStepsById();
    const previousValue = renderedSteps[lastStepIndex].value;
    return typeof message === 'function' ? message({ previousValue, steps }) : message;
  };

  generateRenderedStepsById = () => {
    const { renderedSteps } = this.state;
    return this.generateStepsById(renderedSteps);
  };

  generateStepsById = previousSteps => {
    const steps = {};

    for (let i = 0, len = previousSteps.length; i < len; i += 1) {
      const { id, message, value, metadata } = previousSteps[i];

      steps[id] = {
        id,
        message,
        value,
        metadata
      };
    }

    return steps;
  };

  metadata = step => {
    const timestamp = { timestamp: new Date().toJSON() };
    return { metadata: Object.assign({}, step.metadata, timestamp) };
  };

  findLastStepWithId = (steps, id) => {
    if (!isVariable(id)) {
      id = makeVariable(id);
    }

    const similarSteps = steps.filter(step => step.id === id);
    return similarSteps.length > 0 ? similarSteps[similarSteps.length - 1] : null;
  };

  evaluateExpression = evalExpression => {
    const previousValues = {};
    const values = {};

    const { renderedSteps, currentStep } = this.state;
    renderedSteps.forEach(step => {
      if (step.value != null) {
        previousValues[step.id] = deepCopy(step.value);
      }
    });
    if (currentStep.value != null) previousValues[currentStep.id] = deepCopy(currentStep.value);

    // eslint-disable-next-line no-eval
    eval(evalExpression);

    // append user assigned values into chat
    for (const id in values) {
      if (Object.prototype.hasOwnProperty.call(values, id)) {
        const newStep = {
          '@class': '.ValueStep',
          id,
          value: values[id]
        };
        renderedSteps.push(newStep);
      }
    }

    this.setState({ renderedSteps });
  };

  triggerNextStep = async data => {
    const { enableMobileAutoFocus, nextStepUrl } = this.props;
    const { renderedSteps, steps } = this.state;
    const { defaultUserSettings } = this.getDefaultSettings();

    let { currentStep, previousStep } = this.state;

    const getValueFromData = () => {
      if (data && data.value) {
        return data.value;
      }
      if (data && Array.isArray(data)) {
        return data.map(each => each.value);
      }
      return null;
    };

    const getLabelFromData = () => {
      if (data && data.label) {
        return data.label;
      }

      if (data && Array.isArray(data)) {
        return data.map(each => each.label).join(', ');
      }

      return data;
    };

    const value = getValueFromData();
    const label = getLabelFromData();

    if (!nextStepUrl && value) {
      if (isNestedVariable(currentStep.id)) {
        this.saveValueAsStep(value, currentStep.id, renderedSteps);
      } else {
        currentStep.value = value;
      }
    }
    if (data && data.hideInput) {
      currentStep.hideInput = data.hideInput;
    }
    if (data && data.hideExtraControl) {
      currentStep.hideExtraControl = data.hideExtraControl;
    }

    if (nextStepUrl && data && value) {
      const { trigger } = await this.saveStepValue(currentStep.id, value, label);
      currentStep.trigger = trigger;
      currentStep.animated = false;
    } else if (data && data.trigger) {
      currentStep.trigger = this.getTriggeredStep(data.trigger, value);
    }

    if (currentStep.options && data) {
      const option = Object.assign({}, currentStep.options.filter(o => deepEqual(o, data))[0]);
      const trigger =
        currentStep.trigger || this.getTriggeredStep(option.trigger, currentStep.value);
      delete currentStep.options;

      // Find the last state and append it to the new one
      const lastSameSteps = renderedSteps.filter(step => step.id === currentStep.id);
      const lastSameStep = lastSameSteps.length > 1 && lastSameSteps[lastSameSteps.length - 2];
      if (typeof lastSameStep.value === 'object' && typeof option.value === 'object') {
        option.value = {
          ...lastSameStep.value,
          ...option.value
        };
      }

      // replace choose option for user message
      currentStep = Object.assign(
        {},
        currentStep,
        defaultUserSettings,
        {
          user: true,
          message: option.label,
          trigger,
          end: !trigger,
          value: option.value,
          '@class': '.TextStep'
        },
        this.metadata(currentStep)
      );

      renderedSteps.pop();
      renderedSteps.push(currentStep);

      this.setState({
        currentStep,
        renderedSteps
      });
    } else if (currentStep.choices && data) {
      const message = data.map(each => each.label).join(', ');
      delete currentStep.choices;

      currentStep = Object.assign(
        {},
        currentStep,
        defaultUserSettings,
        {
          user: true,
          message,
          value
        },
        this.metadata(currentStep)
      );

      renderedSteps.pop();
      renderedSteps.push(currentStep);

      this.setState({
        currentStep,
        renderedSteps
      });
    } else if (currentStep.end) {
      this.handleEnd();
    } else if (currentStep.trigger) {
      if (currentStep.replace) {
        renderedSteps.pop();
      }
      const nextStep = await this.getNextStep(currentStep, steps);

      // TODO: Remove after update logic is done.
      if (nextStepUrl) steps[nextStep.id] = nextStep;

      previousStep = currentStep;
      currentStep = nextStep;

      this.setState({ renderedSteps, currentStep, previousStep, steps }, () => {
        if (nextStep.user) {
          this.setState({ disabled: false }, () => {
            if (enableMobileAutoFocus || !isMobile()) {
              if (this.input) {
                this.input.focus();
              }
            }
          });
        } else {
          renderedSteps.push(nextStep);

          this.setState({ renderedSteps });
        }
      });
    }

    const { cache, cacheName } = this.props;
    if (cache) {
      // TODO: Get rid of this setTimeout (use promises/async-await)
      setTimeout(() => {
        storage.setData(cacheName, {
          currentStep,
          previousStep,
          renderedSteps
        });
      }, 10);
    }

    const { handleNextStep } = this.props;
    if (handleNextStep) {
      // TODO: Get rid of this setTimeout (use promises/async-await)
      setTimeout(() => {
        handleNextStep({
          currentStep,
          previousStep,
          renderedSteps
        });
      }, 300);
    }
  };

  getNextStep = async (currentStep, steps) => {
    const { nextStepUrl, botDelay, customDelay } = this.props;
    const trigger = this.getTriggeredStep(currentStep.trigger, currentStep.value);

    this.setState({ isStepFetchingInProgress: true });
    const startTime = Date.now();

    let nextStep;

    if (!nextStepUrl) {
      nextStep = Object.assign({}, steps[trigger]);

      if (nextStep.message) {
        nextStep.animated = false;
        nextStep.message = this.getStepMessage(nextStep.message);
      } else if (nextStep.update) {
        const updateStep = nextStep;
        nextStep = Object.assign({}, steps[updateStep.update], { updatedBy: updateStep.id });
        nextStep.end = updateStep.end;
        nextStep.id = updateStep.update;
        if (nextStep.options || updateStep.updateOptions) {
          if (updateStep.updateOptions) {
            nextStep.options = updateStep.updateOptions;
          } else {
            for (let i = 0, len = nextStep.options.length; i < len; i += 1) {
              nextStep.options[i].trigger = updateStep.trigger;
            }
          }
          nextStep.user = false;
        } else {
          if (updateStep.updateUser) nextStep.user = updateStep.updateUser;
          if (updateStep.validator) nextStep.validator = updateStep.validator;
          if (updateStep.parser) nextStep.parser = updateStep.parser;
          nextStep.trigger = updateStep.trigger;
        }
      }

      if (typeof nextStep.evalExpression === 'string') {
        this.evaluateExpression(nextStep.evalExpression);
      }
    } else {
      const nextSteps = await this.getStepsFromApi(trigger);
      const lastIndex = nextSteps.length - 1;
      const { renderedSteps } = this.state;

      for (let i = 0; i < lastIndex; i += 1) {
        nextSteps[i]['@class'] = '.ValueStep';
        renderedSteps.push(nextSteps[i]);
      }

      nextStep = nextSteps[lastIndex];

      const nextStepIsTextStep = nextStep.message;
      if (nextStepIsTextStep) {
        nextStep.animated = false;
        nextStep.message = this.getStepMessage(nextStep.message);
      }
    }

    const { partialDelayedInMilliseconds } = this.state;
    const timeDuration = Date.now() - startTime - partialDelayedInMilliseconds;
    if (nextStep.message) {
      await sleep(Math.max(botDelay - timeDuration, 0));
    } else if (nextStep.component) {
      await sleep(Math.max(customDelay - timeDuration, 0));
    }
    this.setState({ isStepFetchingInProgress: false, partialDelayedInMilliseconds: 0 });

    return nextStep;
  };

  getStepsFromApi = async (stepId, value) => {
    const { nextStepUrl, parseStep, readOnly } = this.props;
    const { sessionId } = this.state;
    const newSteps = await getStepsFromBackend(nextStepUrl, stepId, value, sessionId, readOnly);

    const completeSteps = [];

    for (const step of newSteps) {
      // TODO: Fix this, because not every steps require parsing
      const parsedStep = parseStep ? parseStep(step) : step;
      const completeStep = this.assignDefaultSetting(schema.parse(parsedStep));

      completeSteps.push(completeStep);
    }

    return completeSteps;
  };

  assignDefaultSetting = step => {
    const {
      defaultBotSettings,
      defaultUserSettings,
      defaultCustomSettings
    } = this.getDefaultSettings();

    let settings = {};
    if (step.user) {
      settings = defaultUserSettings;
    } else if (step.message || step.asMessage) {
      settings = defaultBotSettings;
    } else if (step.component) {
      settings = defaultCustomSettings;
    }

    return Object.assign({}, settings, step);
  };

  saveValueAsStep = (value, id, renderedSteps) => {
    const [parentObjectName, remaining] = splitByFirstPeriod(id);
    const parentStep = this.findLastStepWithId(renderedSteps, parentObjectName);
    if (!parentStep) {
      // eslint-disable-next-line no-console
      console.error('Error: Could not find parent step of the nested variable');
    } else {
      const newStep = {
        '@class': '.ValueStep',
        id: parentStep.id,
        value: deepCopy(parentStep.value)
      };
      insertIntoObjectByPath(newStep.value, remaining, value);

      // put newStep in second last position as some code later is going to replace last current element with updated current element
      const lastStepOfRenderedSteps = renderedSteps.pop();
      renderedSteps.push(newStep);
      if (lastStepOfRenderedSteps) renderedSteps.push(lastStepOfRenderedSteps);
    }
  };

  handleEnd = () => {
    const { handleEnd } = this.props;

    if (handleEnd) {
      const { renderedSteps } = this.state;

      const renderedStepsTrimmed = renderedSteps.map(step => {
        const { id, message, value, metadata } = step;

        return {
          id,
          message,
          value,
          metadata
        };
      });

      const steps = [];

      for (let i = 0, len = renderedSteps.length; i < len; i += 1) {
        const { id, message, value, metadata } = renderedSteps[i];

        steps[id] = {
          id,
          message,
          value,
          metadata
        };
      }

      const values = renderedSteps.filter(step => step.value).map(step => step.value);

      handleEnd({ renderedStepsTrimmed, steps, values });
    }
  };

  isInputValueEmpty = () => {
    const { inputValue } = this.state;
    return !inputValue || inputValue.length === 0;
  };

  isLastPosition = step => {
    const { renderedSteps } = this.state;
    const { length } = renderedSteps;
    const stepIndex = renderedSteps.map(s => s.id).indexOf(step.id);

    if (length <= 1 || stepIndex + 1 === length) {
      return true;
    }

    const nextStep = renderedSteps[stepIndex + 1];
    const hasMessage = nextStep.message || nextStep.asMessage;

    if (!hasMessage) {
      return true;
    }

    const isLast = step.user !== nextStep.user;
    return isLast;
  };

  isFirstPosition = step => {
    const { renderedSteps } = this.state;
    const stepIndex = renderedSteps.map(s => s.id).indexOf(step.id);

    if (stepIndex === 0) {
      return true;
    }

    const lastStep = renderedSteps[stepIndex - 1];
    const hasMessage = lastStep.message || lastStep.asMessage;

    if (!hasMessage) {
      return true;
    }

    const isFirst = step.user !== lastStep.user;
    return isFirst;
  };

  handleKeyPress = event => {
    if (event.key === 'Enter') {
      this.submitUserMessage();
    }
  };

  handleSubmitButton = () => {
    const { speaking, recognitionEnable } = this.state;

    if ((this.isInputValueEmpty() || speaking) && recognitionEnable) {
      this.recognition.speak();
      if (!speaking) {
        this.setState({ speaking: true });
      }
      return;
    }

    this.submitUserMessage();
  };

  submitUserMessage = async () => {
    const { nextStepUrl } = this.props;
    const { inputValue, renderedSteps, disabled } = this.state;
    const { defaultUserSettings } = this.getDefaultSettings();
    let { currentStep } = this.state;

    const isInvalid = currentStep.validator && this.checkInvalidInput();

    const parsedValue = currentStep.parser ? currentStep.parser(inputValue) : inputValue;

    if (disabled) {
      return;
    }

    if (!isInvalid) {
      const step = {
        message: inputValue,
        value: parsedValue
      };

      if (!nextStepUrl && isNestedVariable(currentStep.id)) {
        // TODO: verify if there is nothing to do with this on state backend
        const [parentObjectName, remaining] = splitByFirstPeriod(currentStep.id);
        const parentStep = this.findLastStepWithId(renderedSteps, parentObjectName);
        if (!parentStep) {
          // eslint-disable-next-line no-console
          console.error('Error: Could not find parent step of the nested variable');
        } else {
          const newStep = {
            '@class': '.ValueStep',
            id: parentStep.id,
            value: deepCopy(parentStep.value)
          };
          insertIntoObjectByPath(newStep.value, remaining, parsedValue);
          renderedSteps.push(newStep);
        }
      }

      currentStep = Object.assign({}, defaultUserSettings, currentStep, step, this.metadata(step));

      this.setState(
        {
          disabled: true
        },
        () => {
          if (this.input) {
            this.input.blur();
          }
        }
      );

      if (nextStepUrl) {
        try {
          const { trigger } = await this.saveStepValue(
            currentStep.id,
            currentStep.value,
            currentStep.message
          );
          currentStep.trigger = trigger;
          currentStep.animated = false;
        } catch (error) {
          // eslint-disable-next-line no-console
          console.error(
            `Could not update step with id: ${currentStep.id} and value ${currentStep.value}`,
            error
          );
        }
      }

      renderedSteps.push(currentStep);
      this.setState({
        currentStep,
        renderedSteps,
        inputValue: ''
      });
    }
  };

  checkInvalidInput = () => {
    const { enableMobileAutoFocus } = this.props;
    const { currentStep, inputValue } = this.state;
    const result = currentStep.validator(inputValue);
    const value = inputValue;

    if (typeof result !== 'boolean' || !result) {
      this.setState(
        {
          inputValue: result.toString(),
          inputInvalid: true,
          disabled: true
        },
        () => {
          setTimeout(() => {
            this.setState(
              {
                inputValue: value,
                inputInvalid: false,
                disabled: false
              },
              () => {
                if (enableMobileAutoFocus || !isMobile()) {
                  if (this.input) {
                    this.input.focus();
                  }
                }
              }
            );
          }, 2000);
        }
      );

      return true;
    }

    return false;
  };

  toggleChatBot = opened => {
    const { toggleFloating } = this.props;

    if (toggleFloating) {
      toggleFloating({ opened });
    } else {
      this.setState({ opened });
    }
  };

  renderStep = (step, index) => {
    const { renderedSteps, currentStep } = this.state;
    const {
      avatarStyle,
      bubbleStyle,
      bubbleOptionStyle,
      customStyle,
      hideBotAvatar,
      hideUserAvatar,
      speechSynthesis,
      readOnly
    } = this.props;
    const { options, component, asMessage, choices } = step;
    const steps = this.generateRenderedStepsById();
    const previousStep = index > 0 ? renderedSteps[index - 1] : {};
    const previousSteps = index > 0 ? this.generateStepsById(renderedSteps.slice(0, index)) : {};

    const disabledStyle = { pointerEvents: 'none' };
    const doNothing = () => {};

    // '.ValueStep's should not be rendered
    if (step['@class'] === '.ValueStep') {
      return null;
    }

    if (component && !asMessage) {
      return (
        <CustomStep
          key={index}
          speak={this.speak}
          step={step}
          steps={steps}
          style={customStyle}
          previousStep={previousStep}
          previousValue={previousStep.value}
          triggerNextStep={this.triggerNextStep}
        />
      );
    }

    if (options) {
      return (
        <OptionsStep
          key={index}
          step={step}
          previousSteps={previousSteps}
          previousValue={previousStep.value}
          triggerNextStep={readOnly ? doNothing : this.triggerNextStep}
          bubbleOptionStyle={bubbleOptionStyle}
          style={readOnly ? disabledStyle : null}
        />
      );
    }

    if (choices) {
      return (
        <MultipleChoiceStep
          key={index}
          speak={this.speak}
          step={step}
          previousValue={previousStep.value}
          bubbleChoiceStyle={bubbleOptionStyle}
          triggerNextStep={readOnly ? doNothing : this.triggerNextStep}
          style={readOnly ? disabledStyle : null}
        />
      );
    }

    return (
      <TextStep
        key={index}
        step={step}
        steps={steps}
        speak={this.speak}
        previousStep={previousStep}
        previousSteps={previousSteps}
        previousValue={previousStep.value}
        triggerNextStep={this.triggerNextStep}
        avatarStyle={avatarStyle}
        bubbleStyle={bubbleStyle}
        hideBotAvatar={hideBotAvatar}
        hideUserAvatar={hideUserAvatar}
        speechSynthesis={speechSynthesis}
        isFirst={this.isFirstPosition(step)}
        isLast={this.isLastPosition(step)}
        progress={currentStep.progress}
      />
    );
  };

  render() {
    const { error } = this.state;
    if (error) {
      return <h1> Component is not working because of unexpected error. </h1>;
    }

    const {
      currentStep,
      disabled,
      inputInvalid,
      inputValue,
      opened,
      renderedSteps,
      speaking,
      recognitionEnable,
      isStepFetchingInProgress,
      partialDelayedInMilliseconds
    } = this.state;
    const {
      className,
      contentStyle,
      extraControl,
      controlStyle,
      floating,
      floatingIcon,
      floatingStyle,
      footerStyle,
      headerComponent,
      headerTitle,
      hideHeader,
      hideSubmitButton,
      inputStyle,
      placeholder,
      inputAttributes,
      recognitionPlaceholder,
      style,
      submitButtonStyle,
      width,
      height,
      readOnly,
      botAvatar,
      avatarStyle,
      bubbleStyle
    } = this.props;

    const header = headerComponent || (
      <Header className="rsc-header">
        <HeaderTitle className="rsc-header-title">{headerTitle}</HeaderTitle>
        {floating && (
          <HeaderIcon className="rsc-header-close-button" onClick={() => this.toggleChatBot(false)}>
            <CloseIcon />
          </HeaderIcon>
        )}
      </Header>
    );

    let customControl;
    if (extraControl !== undefined) {
      customControl = React.cloneElement(extraControl, {
        disabled,
        speaking,
        invalid: inputInvalid
      });
    }

    const icon =
      (this.isInputValueEmpty() || speaking) && recognitionEnable ? <MicIcon /> : <SubmitIcon />;

    const inputPlaceholder = speaking
      ? recognitionPlaceholder
      : currentStep.placeholder || placeholder;

    const inputAttributesOverride = currentStep.inputAttributes || inputAttributes;

    const wasPartiallyDelayedBefore = partialDelayedInMilliseconds !== 0;

    const lastRenderedStep = renderedSteps[renderedSteps.length - 1];
    const showLoadingStepAvatar =
      lastRenderedStep &&
      (!(lastRenderedStep.message || lastRenderedStep.asMessage) || lastRenderedStep.user);

    return (
      <div className={`rsc ${className}`} style={readOnly ? { cursor: 'not-allowed' } : null}>
        {floating && (
          <FloatButton
            className="rsc-float-button"
            style={floatingStyle}
            opened={opened}
            onClick={() => this.toggleChatBot(true)}
          >
            {typeof floatingIcon === 'string' ? <FloatingIcon src={floatingIcon} /> : floatingIcon}
          </FloatButton>
        )}
        <ChatBotContainer
          className="rsc-container"
          floating={floating}
          floatingStyle={floatingStyle}
          opened={opened}
          style={style}
          width={width}
          height={height}
        >
          {!hideHeader && header}
          <Content
            className="rsc-content"
            ref={this.setContentRef}
            floating={floating}
            style={contentStyle}
            height={height}
            hideInput={currentStep.hideInput}
          >
            {renderedSteps.map(this.renderStep)}
            {isStepFetchingInProgress && (
              <TextLoadingStep
                showAvatar={showLoadingStepAvatar}
                animated={!wasPartiallyDelayedBefore}
                avatarStyle={avatarStyle}
                bubbleStyle={bubbleStyle}
                avatar={botAvatar}
                user={false}
              />
            )}
          </Content>
          <Footer className="rsc-footer" style={footerStyle}>
            {!currentStep.hideInput && (
              <Input
                type="textarea"
                style={inputStyle}
                ref={this.setInputRef}
                className="rsc-input"
                placeholder={inputInvalid ? '' : inputPlaceholder}
                onKeyPress={this.handleKeyPress}
                onChange={this.onValueChange}
                value={inputValue}
                floating={floating}
                invalid={inputInvalid}
                disabled={disabled || readOnly}
                hasButton={!hideSubmitButton}
                {...inputAttributesOverride}
              />
            )}
            <div style={controlStyle} className="rsc-controls">
              {!currentStep.hideInput && !currentStep.hideExtraControl && customControl}
              {!currentStep.hideInput && !hideSubmitButton && (
                <SubmitButton
                  className="rsc-submit-button"
                  style={submitButtonStyle}
                  onClick={this.handleSubmitButton}
                  invalid={inputInvalid}
                  disabled={disabled}
                  speaking={speaking}
                >
                  {icon}
                </SubmitButton>
              )}
            </div>
          </Footer>
        </ChatBotContainer>
      </div>
    );
  }
}

ChatBot.propTypes = {
  nextStepUrl: PropTypes.string,
  parseStep: PropTypes.func,
  avatarStyle: PropTypes.objectOf(PropTypes.any),
  botAvatar: PropTypes.string,
  botDelay: PropTypes.number,
  bubbleOptionStyle: PropTypes.objectOf(PropTypes.any),
  bubbleStyle: PropTypes.objectOf(PropTypes.any),
  cache: PropTypes.bool,
  cacheName: PropTypes.string,
  className: PropTypes.string,
  contentStyle: PropTypes.objectOf(PropTypes.any),
  customDelay: PropTypes.number,
  customStyle: PropTypes.objectOf(PropTypes.any),
  controlStyle: PropTypes.objectOf(PropTypes.any),
  enableMobileAutoFocus: PropTypes.bool,
  enableSmoothScroll: PropTypes.bool,
  extraControl: PropTypes.element,
  floating: PropTypes.bool,
  floatingIcon: PropTypes.oneOfType([PropTypes.string, PropTypes.element]),
  floatingStyle: PropTypes.objectOf(PropTypes.any),
  footerStyle: PropTypes.objectOf(PropTypes.any),
  handleEnd: PropTypes.func,
  handleNextStep: PropTypes.func,
  headerComponent: PropTypes.element,
  headerTitle: PropTypes.string,
  height: PropTypes.string,
  hideBotAvatar: PropTypes.bool,
  hideHeader: PropTypes.bool,
  hideSubmitButton: PropTypes.bool,
  hideUserAvatar: PropTypes.bool,
  inputAttributes: PropTypes.objectOf(PropTypes.any),
  inputStyle: PropTypes.objectOf(PropTypes.any),
  opened: PropTypes.bool,
  toggleFloating: PropTypes.func,
  placeholder: PropTypes.string,
  recognitionEnable: PropTypes.bool,
  recognitionLang: PropTypes.string,
  recognitionPlaceholder: PropTypes.string,
  speechSynthesis: PropTypes.shape({
    enable: PropTypes.bool,
    lang: PropTypes.string,
    voice:
      typeof window !== 'undefined'
        ? PropTypes.instanceOf(window.SpeechSynthesisVoice)
        : PropTypes.any
  }),
  steps: PropTypes.arrayOf(PropTypes.object),
  style: PropTypes.objectOf(PropTypes.any),
  submitButtonStyle: PropTypes.objectOf(PropTypes.any),
  userAvatar: PropTypes.string,
  userDelay: PropTypes.number,
  width: PropTypes.string,
  readOnly: PropTypes.bool
};

ChatBot.defaultProps = {
  nextStepUrl: undefined,
  parseStep: undefined,
  steps: undefined,
  avatarStyle: {},
  botDelay: 1000,
  bubbleOptionStyle: {},
  bubbleStyle: {},
  cache: false,
  cacheName: 'rsc_cache',
  className: '',
  contentStyle: {},
  customStyle: {},
  controlStyle: { position: 'absolute', right: '0', top: '0' },
  customDelay: 1000,
  enableMobileAutoFocus: false,
  enableSmoothScroll: false,
  extraControl: undefined,
  floating: false,
  floatingIcon: <ChatIcon />,
  floatingStyle: {},
  footerStyle: {},
  handleEnd: undefined,
  handleNextStep: undefined,
  headerComponent: undefined,
  headerTitle: 'Chat',
  height: '520px',
  hideBotAvatar: false,
  hideHeader: false,
  hideSubmitButton: false,
  hideUserAvatar: false,
  inputStyle: {},
  opened: undefined,
  placeholder: 'Type the message ...',
  inputAttributes: {},
  recognitionEnable: false,
  recognitionLang: 'en',
  recognitionPlaceholder: 'Listening ...',
  speechSynthesis: {
    enable: false,
    lang: 'en',
    voice: null
  },
  style: {},
  submitButtonStyle: {},
  toggleFloating: undefined,
  userDelay: 1000,
  width: '350px',
  readOnly: false,
  botAvatar:
    "data:image/svg+xml,%3csvg version='1' xmlns='http://www.w3.org/2000/svg' viewBox='0 0 512 512'%3e%3cpath d='M303 70a47 47 0 1 0-70 40v84h46v-84c14-8 24-23 24-40z' fill='%2393c7ef'/%3e%3cpath d='M256 23v171h23v-84a47 47 0 0 0-23-87z' fill='%235a8bb0'/%3e%3cpath fill='%2393c7ef' d='M0 240h248v124H0z'/%3e%3cpath fill='%235a8bb0' d='M264 240h248v124H264z'/%3e%3cpath fill='%2393c7ef' d='M186 365h140v124H186z'/%3e%3cpath fill='%235a8bb0' d='M256 365h70v124h-70z'/%3e%3cpath fill='%23cce9f9' d='M47 163h419v279H47z'/%3e%3cpath fill='%2393c7ef' d='M256 163h209v279H256z'/%3e%3cpath d='M194 272a31 31 0 0 1-62 0c0-18 14-32 31-32s31 14 31 32z' fill='%233c5d76'/%3e%3cpath d='M380 272a31 31 0 0 1-62 0c0-18 14-32 31-32s31 14 31 32z' fill='%231e2e3b'/%3e%3cpath d='M186 349a70 70 0 1 0 140 0H186z' fill='%233c5d76'/%3e%3cpath d='M256 349v70c39 0 70-31 70-70h-70z' fill='%231e2e3b'/%3e%3c/svg%3e",
  userAvatar:
    "data:image/svg+xml,%3csvg viewBox='-208.5 21 100 100' xmlns='http://www.w3.org/2000/svg' xmlns:xlink='http://www.w3.org/1999/xlink'%3e%3ccircle cx='-158.5' cy='71' fill='%23F5EEE5' r='50'/%3e%3cdefs%3e%3ccircle cx='-158.5' cy='71' id='a' r='50'/%3e%3c/defs%3e%3cclipPath id='b'%3e%3cuse overflow='visible' xlink:href='%23a'/%3e%3c/clipPath%3e%3cpath clip-path='url(%23b)' d='M-108.5 121v-14s-21.2-4.9-28-6.7c-2.5-.7-7-3.3-7-12V82h-30v6.3c0 8.7-4.5 11.3-7 12-6.8 1.9-28.1 7.3-28.1 6.7v14h100.1z' fill='%23E6C19C'/%3e%3cg clip-path='url(%23b)'%3e%3cdefs%3e%3cpath d='M-108.5 121v-14s-21.2-4.9-28-6.7c-2.5-.7-7-3.3-7-12V82h-30v6.3c0 8.7-4.5 11.3-7 12-6.8 1.9-28.1 7.3-28.1 6.7v14h100.1z' id='c'/%3e%3c/defs%3e%3cclipPath id='d'%3e%3cuse overflow='visible' xlink:href='%23c'/%3e%3c/clipPath%3e%3cpath clip-path='url(%23d)' d='M-158.5 100.1c12.7 0 23-18.6 23-34.4 0-16.2-10.3-24.7-23-24.7s-23 8.5-23 24.7c0 15.8 10.3 34.4 23 34.4z' fill='%23D4B08C'/%3e%3c/g%3e%3cpath d='M-158.5 96c12.7 0 23-16.3 23-31 0-15.1-10.3-23-23-23s-23 7.9-23 23c0 14.7 10.3 31 23 31z' fill='%23F2CEA5'/%3e%3c/svg%3e"
};

export default ChatBot;
